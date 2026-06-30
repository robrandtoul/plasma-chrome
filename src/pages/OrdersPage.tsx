import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { DesignerChrome, PanelShell, Pill, ButtonInk, ButtonGhost, Textarea } from '../design'
import { useAuth } from '../lib/auth'
import { formatPrice } from '../lib/currency'
import { getExchangeRates, currencyToGbp, type ExchangeRates } from '../lib/exchangeRates'
import { customerOrderUrl } from '../lib/customerOrderUrl'
import { orderTotal, specLabel as specLabelShared, customerLabel as customerLabelShared } from '../lib/orderDisplay'
import { logAudit } from '../lib/audit'
import { getOrderingEnabled } from '../lib/orderingEnabled'
import { keepApprovedNoOrder, invalidateApprovedNoOrderCount } from '../lib/approvedNoOrder'
import { materialNeedsStockColour, fetchStockColours, type StockColour } from '../lib/stockColours'
import { downloadBlob } from '../lib/downloadFile'
import type { GridImage } from '../components/ImageGrid'
import type { Currency } from '../lib/types'
import { relativeTime, formatAbsoluteDateTime } from '../lib/relativeTime'
import OrdersPipelineCard from '../components/OrdersPipelineCard'
import OrderBuilderModal from '../components/OrderBuilderModal'
import RecordOfflinePaymentModal from '../components/RecordOfflinePaymentModal'
import EditOrderModal from '../components/EditOrderModal'
import DesignerAvatar from '../components/DesignerAvatar'
import { ChevronRight, StickyNote } from 'lucide-react'

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
  // Order-placement fields (000252).
  date_required: string | null
  dropbox_folder_url: string | null
  stock_order_number: string | null
  project_name: string | null
  // Specific Stock Control colour for plastic/acrylic cards (000289).
  stock_colour: string | null
  person_quantities: { name: string; quantity: number }[] | null
  ship_to_name: string | null
  ship_to_email: string | null
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
  proofs: {
    // Thread-wide reply stamps (000208) — drive the specific grace-pause label.
    helpscout_last_reply_at: string | null
    helpscout_last_customer_reply_at: string | null
    contacts: { full_name: string | null; companies: { name: string | null } | null } | null
  } | null
}

const SELECT = `
  id, status, token, expires_at, sent_at, pay_link_opened_at, currency, quantity, names_count, has_personalisation,
  custom_quote_total, amount_cards, amount_tooling, amount_personalisation, amount_shipping, amount_us_tariff,
  card_discount_type, card_discount_value, amount_card_discount, payment_method, order_kind,
  payment_reference, xero_invoice_id, xero_invoice_error, paid_at, fulfilled_at, revised_at,
  date_required, dropbox_folder_url, stock_order_number, project_name, stock_colour, person_quantities,
  ship_to_name, ship_to_email, ship_to_address, proof_id,
  material_variants(display_name, materials(code, display_name, production_route, lead_time_max_days, outsourced_supplier_ids)),
  proofs(helpscout_last_reply_at, helpscout_last_customer_reply_at, contacts(full_name, companies(name)))
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

// Production route from the order's material. 'supplier' is the outsourced
// route (phase 2 — the supplier-email hand-off); 'in_house' posts the
// production note. Null when the material is unknown (custom quote).
function routeOf(o: OrderRow): 'in_house' | 'supplier' | null {
  const r = o.material_variants?.materials?.production_route
  return r === 'supplier' ? 'supplier' : r === 'in_house' ? 'in_house' : null
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
  isCustomQuote: boolean
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

// Free-text match across the fields a designer would search by: customer /
// company, payment + stock order references, project name, and the spec label.
function matchesSearch(o: OrderRow, q: string): boolean {
  if (!q) return true
  const haystack = [
    customerLabel(o),
    o.payment_reference,
    o.stock_order_number,
    o.project_name,
    specLabel(o),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return haystack.includes(q)
}

// Which work-queue section is shown. 'all' shows every section; the others
// narrow to one so a busy queue can be focused.
type ViewKey = 'all' | 'links' | 'awaiting' | 'to_order' | 'revised' | 'recent'

const VIEW_TABS: { key: ViewKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'links', label: 'Links to send' },
  { key: 'awaiting', label: 'Awaiting payment' },
  { key: 'to_order', label: 'To order' },
  { key: 'revised', label: 'Being revised' },
  { key: 'recent', label: 'Recently ordered' },
]

// One tile in the action-led pipeline header. The headline is a COUNT (the
// useful figure for a pipeline stage — "how many", not a part-known "how
// much"), with an optional money line shown only where the value is real
// (paid orders awaiting placement). `emphasis` marks the stages that need the
// team's action so they stand out from the passive waiting states.
function FunnelStat({
  label,
  count,
  money,
  detail,
  emphasis = false,
}: {
  label: string
  count: number
  money?: string | null
  detail?: string | null
  emphasis?: boolean
}) {
  return (
    <div className={`min-w-0 rounded-xl border px-4 py-3 sm:flex-1 ${emphasis ? 'border-line bg-surface' : 'border-line-soft bg-canvas'}`}>
      <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-mute">{label}</span>
      <span className="mt-0.5 flex items-baseline gap-1.5">
        <span className={`text-xl font-semibold ${emphasis ? 'text-ink' : 'text-ink-soft'}`}>{count}</span>
        {money ? <span className="text-[12px] font-medium text-ink-soft">{money}</span> : null}
      </span>
      {detail ? <span className="mt-0.5 block text-[12px] text-ink-mute">{detail}</span> : null}
    </div>
  )
}

// A between-tiles flow chevron, signalling the header reads left-to-right as a
// pipeline. Shown only at sm+ (single row); on the mobile 2×2 grid it's hidden
// (display:none) so it doesn't consume a grid cell.
function FlowArrow() {
  return (
    <div className="hidden shrink-0 items-center self-center text-ink-mute sm:flex" aria-hidden="true">
      <ChevronRight size={18} />
    </div>
  )
}

// A short GBP figure for the To-order value / section subtotals.
function gbpLabel(amount: number): string {
  return formatPrice(Math.round(amount), 'GBP')
}

// Median of a numeric list (even length → mean of the two middles). Null when empty.
function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// Human label for a time-to-pay measured in days.
function payDurationLabel(days: number): string {
  if (days < 1) return 'a day'
  const n = Math.round(days)
  return `${n} day${n === 1 ? '' : 's'}`
}

export default function OrdersPage() {
  const { session } = useAuth()
  // The signed-in staffer's id — stamped as the author when they write a
  // Links-to-send note (the table's RLS requires created_by = auth.uid()).
  const userId = session?.user.id ?? null
  const [loading, setLoading] = useState(true)
  const [orders, setOrders] = useState<OrderRow[]>([])
  // True when the 300-row fetch ceiling was hit, so the page can say so rather
  // than silently dropping older orders (the full history lives in the log).
  const [capped, setCapped] = useState(false)
  const [thumbs, setThumbs] = useState<Record<string, GridImage | null>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  // The awaiting-payment order being recorded as paid offline (bank transfer),
  // or null when the modal is closed.
  const [recordOffline, setRecordOffline] = useState<OrderRow | null>(null)
  // The unpaid order being edited in place (thickness/quantity/etc.), if any.
  const [editingOrder, setEditingOrder] = useState<OrderRow | null>(null)
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
  // Work-queue search + which section is shown.
  const [search, setSearch] = useState('')
  const [view, setView] = useState<ViewKey>('all')
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
  const [conversion, setConversion] = useState<{ sent: number; paid: number; medianDays: number | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      void getExchangeRates().then((r) => { if (!cancelled) setRates(r) })
      void getOrderingEnabled().then((v) => { if (!cancelled) setOrderingEnabled(v) })

      // Representative thumbnail per proof — a recognition aid so a card can be
      // identified at a glance; the card links to the proof for the authoritative
      // approved artwork. customer-proof-images returns EVERY version's images
      // (the customer page has a version switcher), so scope the thumbnail to the
      // CURRENT version — otherwise an earlier version's artwork shows (e.g. a v1
      // plastic card for a proof now approved in wood). Falls back to the first
      // non-QR image when the current version can't be resolved. Shared by every
      // card type that shows a thumbnail: To order, Being revised, Awaiting
      // payment, and the Links-to-send worklist.
      const loadThumbs = async (proofIds: string[]) => {
        await Promise.all(
          proofIds.map(async (proofId) => {
            try {
              const [{ data: curV }, { data: imgData }] = await Promise.all([
                supabase.from('proof_versions').select('id').eq('proof_id', proofId).eq('is_current', true).maybeSingle(),
                supabase.functions.invoke<{ images: GridImage[] }>('customer-proof-images', { body: { proofId } }),
              ])
              const currentVersionId = (curV as { id?: string } | null)?.id ?? null
              const nonQr = (imgData?.images ?? []).filter((img) => img.is_qr_code !== true)
              const scoped = currentVersionId
                ? nonQr.filter((img) => (img as unknown as { proof_version_id?: string }).proof_version_id === currentVersionId)
                : []
              const first = (scoped.length > 0 ? scoped : nonQr)[0] ?? null
              if (!cancelled) setThumbs((prev) => ({ ...prev, [proofId]: first }))
            } catch {
              // ignore — card renders without a thumbnail
            }
          }),
        )
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
        // Conversion health (since launch): paid vs sent links, median time-to-pay.
        const sentCount = orderList.filter((r) => r.sent_at).length
        const paidCount = orderList.filter((r) => r.paid_at).length
        const durations = orderList
          .filter((r) => r.sent_at && r.paid_at)
          .map((r) => new Date(r.paid_at!).getTime() - new Date(r.sent_at!).getTime())
          .filter((ms) => Number.isFinite(ms) && ms >= 0)
        const med = median(durations)
        setConversion({ sent: sentCount, paid: paidCount, medianDays: med != null ? med / DAY_MS : null })
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
      if (!error) {
        setOrders((prev) => prev.map((r) => (r.id === o.id ? { ...r, expires_at: nextExpiry } : r)))
        void logAudit({
          action: 'order.link_reactivated',
          targetType: 'order',
          targetId: o.id,
          targetLabel: `Order ${o.payment_reference ?? o.id}`,
          beforeValue: { expires_at: o.expires_at },
          afterValue: { expires_at: nextExpiry },
        })
      }
    } finally {
      setBusyId(null)
    }
  }

  // Cancel an unpaid order link (abort). order-lifecycle flips sent→cancelled,
  // posts the customer a Help Scout note, and writes the audit row server-side —
  // so no client logAudit here (that would double-log). The page never refetches,
  // so drop the row locally to remove the card.
  async function cancelOrder(o: OrderRow) {
    if (!window.confirm('Cancel this unpaid order link? The customer will be told it has been cancelled.')) return
    setBusyId(o.id)
    try {
      const { data, error } = await supabase.functions.invoke<{ ok: boolean; status?: string; error?: string }>(
        'order-lifecycle',
        { body: { order_id: o.id, action: 'cancel', reason: 'abort', notify: true } },
      )
      if (error || !data?.ok) {
        window.alert(`Could not cancel the order: ${error?.message ?? data?.error ?? 'unknown error'}`)
        return
      }
      setOrders((prev) => prev.filter((r) => r.id !== o.id))
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
        window.alert('Could not load this proof to start an order. Open the proof and use Create order there.')
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
        isCustomQuote: !!ver.custom_quote,
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
      // Awaiting payment: expired links (need reactivating) float up, then the
      // longest-outstanding first so the oldest chases surface at the top.
      awaitingPayment: filtered
        .filter((o) => o.status === 'sent')
        .sort((a, b) => {
          const ae = isExpired(a) ? 0 : 1
          const be = isExpired(b) ? 0 : 1
          if (ae !== be) return ae - be
          return new Date(a.sent_at ?? 0).getTime() - new Date(b.sent_at ?? 0).getTime()
        }),
      // To order: paid, not yet placed. A blocking problem (failed invoice)
      // floats to the top; otherwise newest-paid-first so the most recently
      // paid order sits at the top.
      toOrder: filtered
        .filter((o) => o.status === 'paid')
        .sort((a, b) => {
          const ap = hasInvoiceProblem(a) ? 0 : 1
          const bp = hasInvoiceProblem(b) ? 0 : 1
          if (ap !== bp) return ap - bp
          return new Date(b.paid_at ?? b.sent_at ?? 0).getTime() - new Date(a.paid_at ?? a.sent_at ?? 0).getTime()
        }),
      recentlyOrdered: filtered.filter((o) => o.status === 'fulfilled').slice(0, 30),
      // Paid/placed orders held while the proof is being redesigned (revision).
      beingRevised: filtered.filter((o) => o.status === 'revision'),
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

  const showSection = (key: ViewKey) => view === 'all' || view === key

  // Whole-pipeline counts for the header tiles (unfiltered — the header is a
  // status overview, independent of the queue's search/filter). The £ on To
  // order is the one figure that's real: paid money awaiting placement.
  const sentAll = orders.filter((o) => o.status === 'sent')
  const paidAll = orders.filter((o) => o.status === 'paid')
  const revisionCount = orders.filter((o) => o.status === 'revision').length

  // Pipeline sidebar buckets (computed from the full order set, independent of
  // the queue's search/filter — the sidebar is a whole-pipeline overview).
  const coldItems = orders
    .filter((o) => o.status === 'sent' && (isExpired(o) || (reminders[o.id]?.highestSentNo ?? 0) >= cadence.max))
    .map((o) => ({
      proofId: o.proof_id,
      label: customerLabel(o),
      reason: isExpired(o) ? 'Link expired' : 'Reminders done, unpaid',
    }))
  const invoiceFailedItems = orders
    .filter((o) => o.status === 'paid' && hasInvoiceProblem(o))
    .map((o) => ({ proofId: o.proof_id, label: customerLabel(o) }))

  return (
    <DesignerChrome active="orders">
      <div className="mx-auto max-w-[1320px] px-4 py-8 sm:px-7">
        <h1 className="text-xl font-semibold text-ink">Orders</h1>
        <p className="mt-1 text-sm text-ink-soft">
          From payment link to production. Paid orders waiting to be compiled and placed — into production or with a supplier — then handed to Stock Control.
        </p>

        {loading ? (
          <p className="mt-8 text-sm text-ink-mute">Loading orders…</p>
        ) : (
          <div className="mt-6 flex flex-col gap-6 lg:flex-row lg:items-start">
            <aside className="lg:order-2 lg:w-[320px] lg:shrink-0">
              <OrdersPipelineCard cold={coldItems} invoiceFailed={invoiceFailedItems} />
            </aside>
            <div className="min-w-0 lg:order-1 lg:flex-1">
            {(orders.length > 0 || approvedNoOrder.length > 0) && (
              <>
                {/* Action-led pipeline header. Each tile counts a funnel stage;
                    the two stages that need our action — links to send, orders
                    to place — are emphasised. Money shows only on To order,
                    where it's real (paid). Awaiting payment leads with a count
                    + at-risk rather than a value: most links are open-quantity,
                    so the value isn't knowable until the customer checks out.
                    Chevrons between tiles (sm+) read the row left-to-right as a
                    flow; on mobile it falls back to a 2×2 grid in the same
                    reading order. */}
                <div className="mb-2 flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-ink-mute">
                  Order pipeline
                  <ChevronRight size={12} aria-hidden="true" />
                </div>
                <div className="grid grid-cols-2 gap-3 sm:flex sm:items-stretch sm:gap-1.5">
                  <FunnelStat label="Links to send" count={approvedNoOrder.length} detail="approved, no link" emphasis />
                  <FlowArrow />
                  <FunnelStat
                    label="Awaiting payment"
                    count={sentAll.length}
                    detail={coldItems.length > 0 ? `${coldItems.length} need a chase` : 'out with customers'}
                  />
                  <FlowArrow />
                  <FunnelStat
                    label="To order"
                    count={paidAll.length}
                    money={paidAll.length > 0 ? gbpLabel(sumGbp(paidAll, rates)) : null}
                    detail="paid, to place"
                    emphasis
                  />
                  <FlowArrow />
                  <FunnelStat label="Being revised" count={revisionCount} detail="on hold" />
                </div>
                {conversion && conversion.sent > 0 && (
                  <p className="mt-1.5 text-[12px] text-ink-mute">
                    Since launch: {Math.round((conversion.paid / conversion.sent) * 100)}% of pay links paid
                    {conversion.medianDays != null ? `, usually within ${payDurationLabel(conversion.medianDays)}` : ''}
                    {conversion.sent < 10 ? ' · still early days' : ''}
                  </p>
                )}
              </>
            )}

            {(orders.length > 0 || approvedNoOrder.length > 0) && (
              <>
                {/* Search + which section to show. */}
                <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search customer, reference or project…"
                    className="h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)] sm:max-w-xs"
                  />
                  <div className="flex flex-wrap gap-1.5">
                    {VIEW_TABS.map((t) => (
                      <button
                        key={t.key}
                        type="button"
                        onClick={() => setView(t.key)}
                        className={`rounded-full px-3 py-1.5 text-[12px] font-medium ring-1 transition-colors ${
                          view === t.key
                            ? 'bg-ink text-surface ring-ink'
                            : 'text-ink-soft ring-line hover:bg-canvas'
                        }`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
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

            {showSection('links') && filteredLinks.length > 0 && (
              <section className="mt-6">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-mute">
                    Links to send · {filteredLinks.length}
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

            {showSection('awaiting') && awaitingPayment.length > 0 && (
              <section className="mt-6">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-mute">
                  Awaiting payment · {awaitingPayment.length}
                </h2>
                <p className="mt-1 text-[13px] text-ink-mute">
                  Payment links that have been sent but not paid yet. Copy a link to re-send it, or reactivate an expired one (extends it {ORDER_EXPIRY_DAYS} days).
                </p>
                <div className="mt-3 space-y-3">
                  {awaitingPayment.map((o) => (
                    <AwaitingPaymentCard
                      key={o.id}
                      order={o}
                      thumb={thumbs[o.proof_id] ?? null}
                      expired={isExpired(o)}
                      busy={busyId === o.id}
                      copied={copiedId === o.id}
                      summary={reminders[o.id] ?? null}
                      cadence={cadence}
                      onCopy={() => void copyLink(o)}
                      onReactivate={() => void reactivate(o)}
                      onEdit={() => setEditingOrder(o)}
                      onCancel={() => void cancelOrder(o)}
                      onRecordOffline={() => setRecordOffline(o)}
                    />
                  ))}
                </div>
              </section>
            )}

            {showSection('to_order') && (
              <section className="mt-10">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-mute">
                    To order · {toOrder.length}
                    {toOrder.length > 0 ? ` · ${gbpLabel(sumGbp(toOrder, rates))}` : ''}
                  </h2>
                  {toOrder.length > 0 && <span className="text-[12px] text-ink-mute">Newest paid first</span>}
                </div>
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
                        <OrderCard
                          key={o.id}
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
                        />
                      ))}
                    </div>
                  )}
                </div>
              </section>
            )}

            {showSection('revised') && beingRevised.length > 0 && (
              <section className="mt-10">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-mute">
                  Being revised · {beingRevised.length} · {gbpLabel(sumGbp(beingRevised, rates))}
                </h2>
                <p className="mt-1 text-[13px] text-ink-mute">
                  Paid orders held while the artwork is being changed. Re-approve the new proof and replace the files in the Dropbox order folder, then review &amp; place again.
                </p>
                <div className="mt-3 space-y-4">
                  {beingRevised.map((o) => (
                    <RevisionCard
                      key={o.id}
                      order={o}
                      thumb={thumbs[o.proof_id] ?? null}
                      copied={copiedId === o.id}
                      onReview={() => navigate(`/orders/${o.id}/place`)}
                      onCopy={() => void copyLink(o)}
                    />
                  ))}
                </div>
              </section>
            )}

            {showSection('recent') && recentlyOrdered.length > 0 && (
              <section className="mt-10">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-mute">Recently ordered</h2>
                <div className="mt-3 divide-y divide-line-soft rounded-xl border border-line bg-surface">
                  {recentlyOrdered.map((o) => (
                    <div key={o.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                      <div className="min-w-0">
                        <Link to={`/proofs/${o.proof_id}`} className="font-medium text-ink hover:underline">
                          {customerLabel(o)}
                        </Link>
                        <span className="ml-2 text-ink-mute">{o.payment_reference}</span>
                      </div>
                      <div className="flex items-center gap-3 text-ink-soft">
                        <span>{o.quantity != null ? `${o.quantity.toLocaleString()} cards` : 'Custom'}</span>
                        <span className="text-ink-mute">Ordered {formatDate(o.fulfilled_at)}</span>
                        <button
                          type="button"
                          onClick={() => void copyLink(o)}
                          title="Copy the customer's order link (doubles as their tracking page)"
                          className="shrink-0 rounded px-2 py-1 text-[12px] text-ink-soft ring-1 ring-line hover:bg-canvas"
                        >
                          {copiedId === o.id ? 'Copied' : 'Copy link'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
            </div>
          </div>
        )}

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

        {editingOrder && (
          <EditOrderModal
            orderId={editingOrder.id}
            customerLabel={customerLabel(editingOrder)}
            materialDisplay={specLabel(editingOrder)}
            onClose={() => setEditingOrder(null)}
            onUpdated={() => void refetchOrder(editingOrder.id)}
          />
        )}
      </div>
    </DesignerChrome>
  )
}

// A paid/placed order held while the proof is being redesigned (revision). The
// card is informational + navigational: the authoritative gates (folder verify,
// re-approval, and — for a previously-placed order — the "old Stock Control job
// cancelled" confirmation) live on the review & place page, which is where
// place-order is actually invoked.
function RevisionCard({
  order,
  thumb,
  copied,
  onReview,
  onCopy,
}: {
  order: OrderRow
  thumb: GridImage | null
  copied: boolean
  onReview: () => void
  onCopy: () => void
}) {
  const wasPlaced = !!order.fulfilled_at
  return (
    <PanelShell>
      <div className="mb-3 rounded-lg bg-out-soft px-3 py-2 text-[13px] font-semibold text-out ring-1 ring-out">
        Paid · revision in progress — do not produce the previous artwork.
      </div>
      <div className="flex flex-col gap-4 md:flex-row md:items-start">
        {thumb && (
          <img
            src={thumb.signed_url}
            alt="Proof artwork"
            className="h-20 w-20 shrink-0 rounded-lg object-cover ring-1 ring-line"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/proofs/${order.proof_id}`} className="text-base font-semibold text-ink hover:underline">
              {customerLabel(order)}
            </Link>
            <Pill colour="out">Revision</Pill>
          </div>
          <p className="mt-0.5 text-sm text-ink-soft">{specLabel(order)}</p>
          <p className="mt-0.5 text-[13px] text-ink-mute">
            {order.payment_reference}
            {order.revised_at ? ` · being revised since ${formatDate(order.revised_at)}` : ''}
          </p>
          <p className="mt-2 text-[13px] text-ink-soft">
            {wasPlaced
              ? 'Already placed: cancel the old Stock Control job, re-approve the new proof, and replace the Dropbox files before re-placing.'
              : 'Re-approve the new proof and replace the Dropbox files, then re-place.'}
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-2 md:items-end">
          <ButtonInk onClick={onReview} className="max-md:w-full max-md:h-[50px] max-md:text-[15px]">Review &amp; place</ButtonInk>
          <div className="flex gap-2 md:contents">
            <Link to={`/proofs/${order.proof_id}`} className="max-md:flex-1">
              <ButtonGhost size="sm" className="max-md:w-full max-md:h-11">View proof &amp; artwork</ButtonGhost>
            </Link>
            <ButtonGhost size="sm" onClick={onCopy} className="max-md:flex-1 max-md:h-11">{copied ? 'Copied' : 'Copy order link'}</ButtonGhost>
          </div>
        </div>
      </div>
    </PanelShell>
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
  onReview,
  onCopy,
  onSaveField,
  onRetryInvoice,
  proofMaterialCode,
}: {
  order: OrderRow
  thumb: GridImage | null
  route: 'in_house' | 'supplier' | null
  supplierLabels: string[]
  supplierCount: number
  suggested: string | null
  busy: boolean
  copied: boolean
  onReview: () => void
  onCopy: () => void
  onSaveField: (patch: Partial<OrderRow>) => Promise<boolean>
  onRetryInvoice: () => void
  proofMaterialCode: string | null
}) {
  const total = orderTotal(order)
  const invoiceError = !order.xero_invoice_id ? friendlyInvoiceError(order.xero_invoice_error) : null
  const addr = order.ship_to_address
  const addrLines = addr
    ? [order.ship_to_name, addr.line1, addr.line2, [addr.city, addr.postal_code].filter(Boolean).join(' '), addr.country]
        .map((s) => (s ?? '').trim())
        .filter(Boolean)
    : []
  const paidDays = daysSince(order.paid_at)

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

  return (
    <PanelShell>
      <div className="flex flex-col gap-4 md:flex-row md:items-start">
        {thumb && (
          <img
            src={thumb.signed_url}
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
            <Pill colour="in-stock">Paid</Pill>
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

          {order.person_quantities && order.person_quantities.length > 0 && (
            <div className="mt-2 rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] text-ink-soft">
              <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-mute">Make</span>
              {order.person_quantities.map((p, i) => (
                <span key={i} className="mr-3 inline-block">
                  <span className="text-ink">{p.quantity.toLocaleString()}</span> {p.name}
                </span>
              ))}
            </div>
          )}
          <p className="mt-0.5 text-[13px] text-ink-mute">
            Ref {order.payment_reference}
            {order.paid_at ? ` · paid ${paidDays === 0 ? 'today' : paidDays === 1 ? 'yesterday' : `${paidDays} days ago`}` : ''}
            {total != null ? ` · ${formatPrice(total, order.currency)}` : ''}
          </p>

          {order.card_discount_type && order.card_discount_type !== 'none' && (
            <p className="mt-0.5 text-[13px] text-in-stock">
              Cards discount: {order.card_discount_type === 'percent'
                ? `${order.card_discount_value ?? 0}% off`
                : `${formatPrice(Number(order.card_discount_value ?? 0), order.currency)} off`}
              {order.amount_card_discount != null && order.amount_card_discount > 0
                ? ` (−${formatPrice(order.amount_card_discount, order.currency)})`
                : ''}
            </p>
          )}

          {invoiceError && (
            <>
              {/* Desktop: full message inline. */}
              <p className="mt-1.5 hidden rounded-lg bg-out-soft px-3 py-2 text-[13px] text-out ring-1 ring-out md:block">
                <span className="font-medium">Invoice not created.</span> {invoiceError}
              </p>
              {/* Mobile: a single 46px row that expands to the full message on tap. */}
              <details className="mt-1.5 rounded-lg bg-out-soft px-3 text-out ring-1 ring-out md:hidden">
                <summary className="flex min-h-[46px] cursor-pointer list-none items-center gap-2 text-[13px] font-medium">
                  <span aria-hidden="true">⚠</span>
                  Xero invoice failed
                </summary>
                <p className="pb-2 text-[13px]">{invoiceError}</p>
              </details>
            </>
          )}

          {/* Placement fields: date required + the Dropbox order folder (the gate). */}
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="block">
              <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-mute">Date required</span>
              <input
                type="date"
                value={dateValue}
                onChange={(e) => void handleDateChange(e.target.value)}
                className="mt-1 h-[38px] max-md:h-12 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
              />
              <div className="mt-1 space-y-0.5 text-[11px]">
                {dateSaving && <span className="block text-ink-mute">Saving…</span>}
                {dateError && <span className="block text-out">Couldn’t save — try again</span>}
                {dateSaved && !dateError && <span className="block text-in-stock">✓ Saved</span>}
                {!dateSaving && !dateError && !dateSaved && !datePersisted && dateValue && (
                  <span className="block text-low">Suggested from lead time — pick the date to confirm</span>
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

          {addrLines.length > 0 ? (
            <>
              {/* Desktop: full address block. */}
              <div className="mt-3 hidden rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] text-ink-soft md:block">
                <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-mute">Deliver to</span>
                {addrLines.map((line, i) => (
                  <span key={i} className="block">{line}</span>
                ))}
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
                </div>
              </details>
            </>
          ) : (
            <p className="mt-3 text-[13px] text-ink-mute">Delivery address on the Stripe payment / Xero invoice.</p>
          )}
        </div>

        <div className="flex shrink-0 flex-col gap-2 md:items-end">
          <ButtonInk onClick={onReview} disabled={!canOrder} className="max-md:w-full max-md:h-[50px] max-md:text-[15px]">
            {route !== 'supplier'
              ? 'Review and push to production'
              : supplierCount > 1
                ? 'Review and choose supplier'
                : supplierCount === 1
                  ? `Review and order from ${supplierLabels[0] ?? 'supplier'}`
                  : 'Review and order from supplier'}
          </ButtonInk>
          {!canOrder && (
            <span className="text-right text-[11px] text-ink-mute max-md:text-center">
              {!folderVerified
                ? 'Link & check the order folder to enable'
                : !datePersisted
                  ? (dateValue ? 'Confirm the date required to enable' : 'Set a date required to enable')
                  : 'Choose the stock colour to enable'}
            </span>
          )}
          {/* Secondary actions: a side column on desktop (md:contents lets each
              button flow as a column child) but a single 44px row on mobile. */}
          <div className="flex gap-2 md:contents">
            <Link to={`/proofs/${order.proof_id}`} className="max-md:flex-1">
              <ButtonGhost size="sm" className="max-md:w-full max-md:h-11">View proof &amp; artwork</ButtonGhost>
            </Link>
            <ButtonGhost size="sm" onClick={onCopy} className="max-md:flex-1 max-md:h-11">{copied ? 'Copied' : 'Copy order link'}</ButtonGhost>
            {/* Download the Xero invoice as a PDF (only once an invoice exists). */}
            {order.xero_invoice_id && (
              <ButtonGhost
                size="sm"
                onClick={() => void handleDownloadInvoice()}
                disabled={pdfBusy}
                className="max-md:flex-1 max-md:h-11"
                title="Download this order's Xero invoice as a PDF"
              >
                {pdfBusy ? 'Downloading…' : pdfError ? 'Try again' : 'Download invoice'}
              </ButtonGhost>
            )}
            {/* Retry invoice is for orders whose AUTO Xero invoice failed. Offline
                orders deliberately have no auto-invoice (raised manually in Xero),
                so retrying would create a DUPLICATE — never offer it for offline. */}
            {!order.xero_invoice_id && order.payment_method !== 'offline' && (
              <ButtonGhost size="sm" onClick={onRetryInvoice} disabled={busy} className="max-md:flex-1 max-md:h-11">
                {busy ? 'Retrying…' : 'Retry invoice'}
              </ButtonGhost>
            )}
          </div>
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
  summary,
  cadence,
  onCopy,
  onReactivate,
  onEdit,
  onCancel,
  onRecordOffline,
}: {
  order: OrderRow
  thumb: GridImage | null
  expired: boolean
  busy: boolean
  copied: boolean
  summary: ReminderSummary | null
  cadence: ReminderCadence
  onCopy: () => void
  onReactivate: () => void
  onEdit: () => void
  onCancel: () => void
  onRecordOffline: () => void
}) {
  const total = orderTotal(order)

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
    <PanelShell>
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        {thumb && (
          <img
            src={thumb.signed_url}
            alt="Proof artwork"
            className="h-20 w-20 shrink-0 rounded-lg object-cover ring-1 ring-line"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/proofs/${order.proof_id}`} className="text-base font-semibold text-ink hover:underline">
              {customerLabel(order)}
            </Link>
            {expired ? <Pill colour="out">Expired</Pill> : <Pill colour="low">Awaiting payment</Pill>}
          </div>
          <p className="mt-0.5 text-sm text-ink-soft">
            {specLabel(order)}
            {' · '}
            {order.quantity != null ? `${order.quantity.toLocaleString()} cards` : 'Customer picks quantity'}
            {total != null ? ` · ${formatPrice(total, order.currency)}` : ''}
          </p>
          <p className="mt-0.5 text-[13px] text-ink-mute">
            Ref {order.payment_reference}
            {order.sent_at ? ` · sent ${formatDate(order.sent_at)}` : ''}
            {order.expires_at ? ` · ${expired ? 'expired' : 'expires'} ${formatDate(order.expires_at)}` : ''}
          </p>
          <p className="mt-0.5 text-[13px] text-ink-mute">
            {order.pay_link_opened_at
              ? <span title={formatAbsoluteDateTime(order.pay_link_opened_at)}>Pay link opened {relativeTime(order.pay_link_opened_at)}</span>
              : 'Pay link not opened yet'}
          </p>
          {/* Auto-chase progress: how many reminders have gone, what's next,
              and any problem stopping the chase. */}
          <div className="mt-1 space-y-0.5 text-[13px]">
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
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-2 md:items-end">
          <ButtonGhost size="sm" onClick={onCopy} className="max-md:w-full max-md:h-11">{copied ? 'Copied' : 'Copy link'}</ButtonGhost>
          {expired && (
            <ButtonInk onClick={onReactivate} disabled={busy} className="max-md:w-full max-md:h-[50px] max-md:text-[15px]">
              {busy ? 'Reactivating…' : 'Reactivate link'}
            </ButtonInk>
          )}
          <ButtonGhost size="sm" onClick={onRecordOffline} disabled={busy} className="max-md:w-full max-md:h-11">Record offline payment</ButtonGhost>
          {(order.order_kind ?? 'production') === 'production' && (
            <ButtonGhost size="sm" onClick={onEdit} disabled={busy} className="max-md:w-full max-md:h-11">Edit order</ButtonGhost>
          )}
          <ButtonGhost size="sm" onClick={onCancel} disabled={busy} className="max-md:w-full max-md:h-11">Cancel order</ButtonGhost>
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
  thumb: GridImage | null
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
            src={thumb.signed_url}
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
        <div className="flex shrink-0 flex-col gap-2 md:items-end">
          {canCreateOrder && (
            <ButtonInk onClick={onCreate} busy={preparing} className="max-md:w-full max-md:h-[50px] max-md:text-[15px]">
              Create order link
            </ButtonInk>
          )}
          {/* Secondary actions: a side column on desktop, a single 44px row on mobile. */}
          <div className="flex gap-2 md:contents">
            {item.helpscoutUrl && (
              <a href={item.helpscoutUrl} target="_blank" rel="noopener noreferrer" className="max-md:flex-1">
                <ButtonGhost size="sm" className="max-md:w-full max-md:h-11">Help Scout ↗</ButtonGhost>
              </a>
            )}
            <Link to={`/proofs/${item.proofId}`} className="max-md:flex-1">
              <ButtonGhost size="sm" className="max-md:w-full max-md:h-11">View proof</ButtonGhost>
            </Link>
          </div>
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
