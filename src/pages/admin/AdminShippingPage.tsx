import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { PanelShell, Pill, Field, Input, ButtonInk, ButtonGhost, ButtonCoral } from '../../design'
import Modal from '../../components/Modal'
import { customerLabel as customerLabelShared, specLabel as specLabelShared, usTariffDutyBilling } from '../../lib/orderDisplay'
import { logAudit } from '../../lib/audit'
import { deriveParcelWeightGrams } from '../../lib/quote/shipping'
import { SHIP_COUNTRIES } from '../../lib/shipCountries'
import { isEuVatCountry } from '../../lib/euVatArea'
import type { Currency } from '../../lib/types'

// Admin → Shipping. A readiness worklist for the delivery details a paid order
// needs before it can be shipped, plus a way to correct or redirect them.
//
// Why it exists: online card payments always capture the delivery address,
// phone and name from Stripe, but OFFLINE and FREE/manual orders reach "paid"
// with all of those blank (record-offline-payment never touches ship_to_*).
// And customers sometimes ask to change where a parcel goes AFTER they've paid.
// Neither had a home — the only address surface was read-only. This tab lists
// post-payment orders missing shipping data (default view) and lets an admin
// fill it in or override it; a search box reaches ANY paid order so a redirect
// isn't limited to the incomplete ones.
//
// Everything writes straight to proofs.orders / proofs.order_groups via the
// authenticated RLS grant (using(true)/with check(true)) — Stock Control reads
// those same rows for the shipping step, so an edit here reaches fulfilment
// with no extra plumbing. Weight is the exception: it isn't stored per order,
// it lives on material_variants.weight_grams (the Card-weights catalogue), so a
// weight fix here writes back there and applies to every card of that
// material + thickness.
//
// Scope note: an order past payment can't be re-priced — shipping, VAT and any
// US tariff were fixed at checkout — so a destination change here redirects the
// PARCEL only; the modal spells that out, and warns when a job has already been
// placed into production (Stock Control may have pulled the old address).

// Post-payment statuses this tab covers ("paid, not yet shipped"). fulfilled =
// already placed into production; included so a parcel can still be redirected
// after hand-off (with a warning). Cancelled / expired / unpaid are excluded.
const COVERED_STATUSES = ['paid', 'revision', 'fulfilled'] as const

// The placeholder weight migration 000178 seeded on every variant. Not a real
// sentinel in the schema, but a card left at exactly 10g almost certainly
// hasn't been weighed — we treat it as "unweighed" so international parcels
// don't rate off a guess. (A genuinely 10g card is indistinguishable; the admin
// can confirm the value and move on.)
const PLACEHOLDER_WEIGHT_GRAMS = 10

interface ShipAddress {
  line1?: string | null
  line2?: string | null
  city?: string | null
  region?: string | null
  postal_code?: string | null
  country?: string | null
}

interface OrderRow {
  id: string
  status: string
  payment_method: string | null
  order_kind: string | null
  payment_reference: string | null
  currency: Currency
  quantity: number | null
  quantity_open: boolean
  custom_quote_total: number | null
  material_id: string | null
  material_variant_id: string | null
  names_count: number
  paid_at: string | null
  fulfilled_at: string | null
  order_group_id: string | null
  proof_id: string
  ship_to_name: string | null
  ship_to_email: string | null
  ship_to_phone: string | null
  // Optional customer VAT / EORI number from EU checkout (migration 000341),
  // for the customs paperwork; also staff-editable here.
  customs_tax_id: string | null
  // US import-duty (tariff) choice from checkout (migrations 000249 / 000342),
  // read-only here — it decides who duties are billed to on the paperwork. On a
  // grouped order the tariff lives on the group, so read it from order_groups.
  amount_us_tariff: number | null
  us_tariff_opted_out: boolean | null
  order_groups: { us_tariff_opted_out: boolean | null; amount_us_tariff: number | null } | null
  ship_to_address: ShipAddress | null
  ship_dest_country: string | null
  ship_dest_postcode: string | null
  material_variants: {
    display_name: string | null
    weight_grams: number | null
    materials: { code: string | null; display_name: string | null } | null
  } | null
  material_options: { display_name: string | null } | null
  proofs: { contacts: { full_name: string | null; companies: { name: string | null } | null } | null } | null
}

const SELECT = `
  id, status, payment_method, order_kind, payment_reference, currency, quantity, quantity_open,
  custom_quote_total, material_id, material_variant_id, names_count, paid_at, fulfilled_at,
  order_group_id, proof_id, ship_to_name, ship_to_email, ship_to_phone, ship_to_address,
  customs_tax_id, amount_us_tariff, us_tariff_opted_out, ship_dest_country, ship_dest_postcode,
  order_groups(us_tariff_opted_out, amount_us_tariff),
  material_variants(display_name, weight_grams, materials(code, display_name)),
  material_options(display_name),
  proofs(contacts(full_name, companies(name)))
`

// ── Readiness rules ────────────────────────────────────────────────────────

type FlagKind = 'address' | 'destination' | 'name' | 'phone' | 'weight' | 'vat'

interface Flag {
  kind: FlagKind
  label: string
  // 1 = blocks shipping outright, 2 = needed on the courier paperwork,
  // 3 = advisory. Drives sort order + chip colour.
  severity: 1 | 2 | 3
}

function customerLabel(o: OrderRow): string {
  return customerLabelShared(o.proofs?.contacts?.companies?.name, o.proofs?.contacts?.full_name)
}

function specLabel(o: OrderRow): string {
  return specLabelShared(
    o.material_variants?.materials?.display_name,
    o.material_variants?.display_name,
    o.custom_quote_total,
    o.material_options?.display_name,
  )
}

// A delivery address is "missing" when there's no first line to put on a label.
// Offline / free orders have the whole jsonb null; that's the common case.
function addressMissing(a: ShipAddress | null): boolean {
  return !a || !(a.line1 && String(a.line1).trim())
}

// Weight only matters where shipping is rated by weight — i.e. everywhere
// except GB (the flat DPD domestic rate). Unknown destinations are treated as
// weight-relevant since they're most likely international.
function weightRelevant(country: string | null): boolean {
  return country !== 'GB'
}

// The per-card weight on record for this order, or null when it can't be known
// (a custom quote / open spec with no resolved variant).
function variantWeight(o: OrderRow): number | null {
  return o.material_variants?.weight_grams ?? null
}

function weightMissing(o: OrderRow): boolean {
  if (!weightRelevant(o.ship_dest_country)) return false
  const w = variantWeight(o)
  return w == null || w === PLACEHOLDER_WEIGHT_GRAMS
}

// 'ZZ' is the offline builder's "International, exact country unknown" sentinel
// (it passes the ^[A-Z]{2}$ check but names no real country). Null is likewise
// unknown. Either means the destination still needs pinning down.
function destinationUnknown(country: string | null): boolean {
  return !country || country === 'ZZ'
}

// A VAT / EORI number smooths customs on EU-bound B2B exports. Advisory only:
// consumer orders won't have one, so this is a "worth checking" nudge (the
// customer is offered the field at EU checkout, migration 000341), not a blocker.
function customsIdMissing(o: OrderRow): boolean {
  if (!isEuVatCountry(o.ship_dest_country)) return false
  return !o.customs_tax_id || !o.customs_tax_id.trim()
}

function flagsFor(o: OrderRow): Flag[] {
  const flags: Flag[] = []
  if (addressMissing(o.ship_to_address)) flags.push({ kind: 'address', label: 'No delivery address', severity: 1 })
  if (destinationUnknown(o.ship_dest_country)) flags.push({ kind: 'destination', label: 'Destination country unknown', severity: 1 })
  if (!o.ship_to_name || !o.ship_to_name.trim()) flags.push({ kind: 'name', label: 'No recipient name', severity: 2 })
  if (!o.ship_to_phone || !o.ship_to_phone.trim()) flags.push({ kind: 'phone', label: 'No phone number', severity: 2 })
  if (customsIdMissing(o)) flags.push({ kind: 'vat', label: 'No VAT/EORI number', severity: 3 })
  if (weightMissing(o)) flags.push({ kind: 'weight', label: 'Card weight not recorded', severity: 3 })
  return flags
}

// Sort weight: most-blocked first (a proxy for "fix these first"). Sum of
// (4 − severity) per flag, so a severity-1 flag outweighs several minor ones.
function urgency(flags: Flag[]): number {
  return flags.reduce((acc, f) => acc + (4 - f.severity), 0)
}

// ── Formatting helpers ───────────────────────────────────────────────────────

const COUNTRY_NAME = new Map(SHIP_COUNTRIES.map((c) => [c.code, c.name]))

function countryLabel(code: string | null): string {
  if (!code) return 'Not set'
  if (code === 'ZZ') return 'International (country not set)'
  return COUNTRY_NAME.get(code) ?? code
}

function addressOneLine(o: OrderRow): string {
  const a = o.ship_to_address
  if (addressMissing(a)) return 'No delivery address on file'
  const parts = [a?.line1, a?.city, a?.postal_code, countryLabel(a?.country ?? o.ship_dest_country)]
    .map((s) => (s ?? '').toString().trim())
    .filter(Boolean)
  return parts.join(', ')
}

function formatWeight(grams: number | null): string {
  if (grams == null) return '—'
  if (grams >= 1000) return `${(grams / 1000).toFixed(2)} kg`
  return `${grams} g`
}

function formatDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

// Chip for one readiness flag — severity drives the tone (rose = blocks,
// amber = paperwork, slate = advisory).
function FlagChip({ flag }: { flag: Flag }) {
  const tone =
    flag.severity === 1
      ? 'bg-[var(--c-out-soft)] text-out ring-[var(--c-out)]/40'
      : flag.severity === 2
        ? 'bg-[var(--c-low-soft)] text-low ring-[var(--c-low)]/40'
        : 'bg-canvas text-ink-mute ring-line'
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${tone}`}>
      {flag.label}
    </span>
  )
}

export default function AdminShippingPage() {
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [boxTareGrams, setBoxTareGrams] = useState<number>(250)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  // Default to the worklist (orders missing something); flip to see everything.
  const [onlyIncomplete, setOnlyIncomplete] = useState(true)
  const [editing, setEditing] = useState<OrderRow | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      setLoadError(null)
      const [{ data, error }, { data: settings }] = await Promise.all([
        supabase
          .from('orders')
          .select(SELECT)
          .in('status', COVERED_STATUSES as unknown as string[])
          .order('paid_at', { ascending: false })
          .limit(300),
        supabase.from('settings').select('fedex_box_weight_grams').eq('id', 1).maybeSingle(),
      ])
      if (cancelled) return
      if (error) {
        setLoadError(error.message)
        setOrders([])
        setLoading(false)
        return
      }
      setOrders((data ?? []) as unknown as OrderRow[])
      const tare = Number((settings as { fedex_box_weight_grams?: number } | null)?.fedex_box_weight_grams)
      setBoxTareGrams(Number.isFinite(tare) && tare >= 0 ? tare : 250)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [reloadKey])

  // Decorate + filter + sort once per data/search change.
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return orders
      .map((o) => ({ o, flags: flagsFor(o) }))
      .filter(({ o, flags }) => {
        if (onlyIncomplete && flags.length === 0) return false
        if (!q) return true
        const hay = [customerLabel(o), o.payment_reference, specLabel(o), o.ship_to_name, o.ship_to_address?.postal_code]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        return hay.includes(q)
      })
      .sort((a, b) => urgency(b.flags) - urgency(a.flags))
  }, [orders, search, onlyIncomplete])

  const incompleteCount = useMemo(() => orders.filter((o) => flagsFor(o).length > 0).length, [orders])

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-ink">Shipping</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Paid orders and the delivery details they need before shipping. Fill in or correct a recipient’s address,
          phone and destination — and set a card weight where one’s missing. Changes save straight to the order that
          Stock Control ships from.
        </p>
      </div>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setOnlyIncomplete(true)}
            aria-pressed={onlyIncomplete}
            className={[
              'rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors',
              onlyIncomplete ? 'bg-ink text-on-ink' : 'bg-surface text-ink-soft ring-1 ring-line hover:bg-canvas',
            ].join(' ')}
          >
            Needs details{incompleteCount > 0 ? ` · ${incompleteCount}` : ''}
          </button>
          <button
            type="button"
            onClick={() => setOnlyIncomplete(false)}
            aria-pressed={!onlyIncomplete}
            className={[
              'rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors',
              !onlyIncomplete ? 'bg-ink text-on-ink' : 'bg-surface text-ink-soft ring-1 ring-line hover:bg-canvas',
            ].join(' ')}
          >
            All paid orders
          </button>
        </div>
        <div className="w-full sm:w-72">
          <Input
            type="search"
            placeholder="Search customer, ref, postcode…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search orders"
          />
        </div>
      </div>

      {loading ? (
        <PanelShell className="text-center"><p className="text-sm text-ink-mute">Loading orders…</p></PanelShell>
      ) : loadError ? (
        <PanelShell className="text-center"><p className="text-sm text-out">Couldn’t load orders: {loadError}</p></PanelShell>
      ) : rows.length === 0 ? (
        <PanelShell className="text-center">
          <p className="text-sm text-ink-soft">
            {search.trim()
              ? 'No orders match your search.'
              : onlyIncomplete
                ? 'Every paid order has its shipping details. Nothing to chase. 🎉'
                : 'No paid orders yet.'}
          </p>
        </PanelShell>
      ) : (
        <div className="space-y-3">
          {rows.map(({ o, flags }) => (
            <ShippingCard key={o.id} order={o} flags={flags} boxTareGrams={boxTareGrams} onEdit={() => setEditing(o)} />
          ))}
        </div>
      )}

      {editing && (
        <ShippingEditModal
          order={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); setReloadKey((k) => k + 1) }}
        />
      )}
    </div>
  )
}

// ── One order row ────────────────────────────────────────────────────────────

function ShippingCard({
  order,
  flags,
  boxTareGrams,
  onEdit,
}: {
  order: OrderRow
  flags: Flag[]
  boxTareGrams: number
  onEdit: () => void
}) {
  const placed = !!order.fulfilled_at
  const qty = order.quantity
  const parcel = deriveParcelWeightGrams(variantWeight(order), qty, boxTareGrams)
  const isGrouped = !!order.order_group_id

  return (
    <PanelShell>
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/proofs/${order.proof_id}`} className="text-base font-semibold text-ink hover:underline">
              {customerLabel(order)}
            </Link>
            {order.status === 'revision' ? <Pill colour="out">Revision</Pill> : <Pill colour="in-stock">Paid</Pill>}
            {placed && <Pill colour="allocated">Placed into production</Pill>}
            {isGrouped && <Pill colour="low">Combined payment</Pill>}
            {order.payment_method === 'offline' && <Pill colour="mute">Offline</Pill>}
          </div>

          <p className="mt-0.5 text-sm text-ink-soft">
            {specLabel(order)}
            {' · '}
            {order.quantity != null ? `${order.quantity.toLocaleString()} cards` : order.quantity_open ? 'Customer picks quantity' : 'Quantity TBC'}
          </p>
          <p className="mt-0.5 text-[13px] text-ink-mute">
            Ref {order.payment_reference}
            {order.paid_at ? ` · paid ${formatDate(order.paid_at)}` : ''}
          </p>

          <p className="mt-2 text-[13px] text-ink-soft">
            <span className="text-ink-mute">Deliver to:</span> {addressOneLine(order)}
          </p>
          <p className="mt-0.5 text-[13px] text-ink-soft">
            <span className="text-ink-mute">Phone:</span> {order.ship_to_phone || '—'}
            <span className="mx-2 text-line">·</span>
            <span className="text-ink-mute">Parcel weight:</span>{' '}
            {weightRelevant(order.ship_dest_country) ? formatWeight(parcel) : 'UK flat rate'}
          </p>
          {isEuVatCountry(order.ship_dest_country) && (
            <p className="mt-0.5 text-[13px] text-ink-soft">
              <span className="text-ink-mute">VAT/EORI:</span> {order.customs_tax_id || '—'}
            </p>
          )}
          {(() => {
            // Group-aware: the tariff lives on the group for a combined payment.
            const src = order.order_group_id && order.order_groups ? order.order_groups : order
            const t = usTariffDutyBilling(src)
            if (!t) return null
            return (
              <p className={`mt-0.5 text-[13px] ${t.optedOut ? 'font-medium text-low' : 'text-ink-soft'}`}>
                <span className="text-ink-mute">US duties:</span> {t.choice} — {t.action}.
              </p>
            )
          })()}

          {flags.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {flags.map((f) => <FlagChip key={f.kind} flag={f} />)}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 md:flex-col md:items-end">
          <ButtonInk onClick={onEdit} className="max-md:h-11 max-md:flex-1">Edit delivery details</ButtonInk>
        </div>
      </div>
    </PanelShell>
  )
}

// ── Edit / override modal ────────────────────────────────────────────────────

function ShippingEditModal({
  order,
  onClose,
  onSaved,
}: {
  order: OrderRow
  onClose: () => void
  onSaved: () => void
}) {
  const a = order.ship_to_address
  const originalCountry = a?.country ?? order.ship_dest_country ?? ''

  const [name, setName] = useState(order.ship_to_name ?? '')
  const [phone, setPhone] = useState(order.ship_to_phone ?? '')
  const [customsTaxId, setCustomsTaxId] = useState(order.customs_tax_id ?? '')
  const [line1, setLine1] = useState(a?.line1 ?? '')
  const [line2, setLine2] = useState(a?.line2 ?? '')
  const [city, setCity] = useState(a?.city ?? '')
  const [region, setRegion] = useState(a?.region ?? '')
  const [postcode, setPostcode] = useState(a?.postal_code ?? order.ship_dest_postcode ?? '')
  // 'ZZ' isn't a real country, so present it as unset for the picker.
  const [country, setCountry] = useState(originalCountry === 'ZZ' ? '' : originalCountry)

  // Weight editor — shown when this order's card thickness has no real weight
  // on record and there's a variant to attach it to.
  const canEditWeight = !!order.material_variant_id && weightMissing(order)
  const [weightStr, setWeightStr] = useState(
    order.material_variants?.weight_grams != null ? String(order.material_variants.weight_grams) : '',
  )

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const placed = !!order.fulfilled_at
  const isGrouped = !!order.order_group_id
  const countryChanged = country !== '' && country !== (originalCountry === 'ZZ' ? '' : originalCountry)
  const materialWeightLabel = [order.material_variants?.materials?.display_name, order.material_variants?.display_name]
    .filter(Boolean)
    .join(' · ')

  async function save() {
    setError(null)
    if (!line1.trim()) { setError('Enter at least the first line of the delivery address.'); return }
    if (!country) { setError('Choose the destination country.'); return }

    // Parse the optional weight override up front so a bad value stops the save.
    let newWeight: number | null = null
    if (canEditWeight && weightStr.trim() !== '') {
      const w = Number(weightStr)
      if (!Number.isInteger(w) || w <= 0) { setError('Card weight must be a whole number of grams above zero.'); return }
      newWeight = w
    }

    const address: ShipAddress = {
      line1: line1.trim() || null,
      line2: line2.trim() || null,
      city: city.trim() || null,
      region: region.trim() || null,
      postal_code: postcode.trim() || null,
      country,
    }
    // ship_dest_* is the rated destination Stock Control reads for the
    // domestic-vs-international packaging line, so keep it in step with the
    // address country/postcode. The charged amounts are frozen — this doesn't
    // re-rate anything.
    const shipPatch = {
      ship_to_name: name.trim() || null,
      ship_to_phone: phone.trim() || null,
      customs_tax_id: customsTaxId.trim() || null,
      ship_to_email: order.ship_to_email ?? null,
      ship_to_address: address,
      ship_dest_country: country,
      ship_dest_postcode: postcode.trim() || null,
      updated_at: new Date().toISOString(),
    }

    setSaving(true)
    try {
      if (isGrouped && order.order_group_id) {
        // One destination for the whole combined payment: write the group and
        // every member so they ship together and Stock Control reads the same
        // address off each member row.
        const groupId = order.order_group_id
        const [{ error: gErr }, { error: mErr }] = await Promise.all([
          supabase.from('order_groups').update({
            ship_to_name: shipPatch.ship_to_name,
            ship_to_phone: shipPatch.ship_to_phone,
            customs_tax_id: shipPatch.customs_tax_id,
            ship_to_email: shipPatch.ship_to_email,
            ship_to_address: shipPatch.ship_to_address,
            ship_dest_country: shipPatch.ship_dest_country,
            ship_dest_postcode: shipPatch.ship_dest_postcode,
            updated_at: shipPatch.updated_at,
          }).eq('id', groupId),
          supabase.from('orders').update(shipPatch).eq('order_group_id', groupId),
        ])
        if (gErr || mErr) { setError(`Couldn’t save: ${(gErr ?? mErr)!.message}`); setSaving(false); return }
      } else {
        const { error: uErr } = await supabase.from('orders').update(shipPatch).eq('id', order.id)
        if (uErr) { setError(`Couldn’t save: ${uErr.message}`); setSaving(false); return }
      }

      // Weight override → the catalogue (all cards of this material + thickness).
      if (newWeight != null && newWeight !== order.material_variants?.weight_grams && order.material_variant_id) {
        const { error: wErr } = await supabase
          .from('material_variants')
          .update({ weight_grams: newWeight })
          .eq('id', order.material_variant_id)
        if (wErr) { setError(`Delivery details saved, but the weight didn’t: ${wErr.message}`); setSaving(false); return }
        void logAudit({
          action: 'material_variant.weights_updated',
          targetType: 'material_variant',
          targetId: order.material_variant_id,
          targetLabel: materialWeightLabel || 'Card weight',
          beforeValue: { weight_grams: order.material_variants?.weight_grams ?? null },
          afterValue: { weight_grams: newWeight },
          metadata: { source: 'shipping_tab', order_id: order.id },
        })
      }

      void logAudit({
        action: 'order.shipping_updated',
        targetType: 'order',
        targetId: order.id,
        targetLabel: `Order ${order.payment_reference ?? order.id}`,
        beforeValue: {
          ship_to_name: order.ship_to_name,
          ship_to_phone: order.ship_to_phone,
          customs_tax_id: order.customs_tax_id,
          ship_to_address: order.ship_to_address,
          ship_dest_country: order.ship_dest_country,
          ship_dest_postcode: order.ship_dest_postcode,
        },
        afterValue: {
          ship_to_name: shipPatch.ship_to_name,
          ship_to_phone: shipPatch.ship_to_phone,
          customs_tax_id: shipPatch.customs_tax_id,
          ship_to_address: shipPatch.ship_to_address,
          ship_dest_country: shipPatch.ship_dest_country,
          ship_dest_postcode: shipPatch.ship_dest_postcode,
        },
        metadata: isGrouped ? { applied_to: 'order_group', order_group_id: order.order_group_id } : undefined,
      })

      onSaved()
    } finally {
      setSaving(false)
    }
  }

  const selectClass =
    'h-[38px] w-full rounded-[8px] border border-line bg-surface px-3 text-sm text-ink ' +
    'focus:outline-2 focus:outline-offset-1 focus:border-[var(--c-brand)] focus:outline-[var(--c-brand)]'

  return (
    <Modal
      open
      onClose={onClose}
      ariaLabel="Edit delivery details"
      panelClassName="w-full max-w-lg md:max-h-[90vh] overflow-y-auto rounded-2xl bg-white shadow-xl"
    >
      <div>
        <div className="sticky top-0 z-10 border-b border-line-soft bg-white px-6 pt-6 pb-4">
          <h2 className="text-lg font-semibold text-ink">Delivery details</h2>
          <p className="mt-1 text-sm text-ink-soft">
            {customerLabel(order)} · {specLabel(order)} · Ref {order.payment_reference}
          </p>
        </div>

        <div className="space-y-5 px-6 py-5">
          {/* Context warnings. */}
          {isGrouped && (
            <div className="rounded-lg border border-low bg-low-soft px-3 py-2.5 text-[13px] text-ink">
              This order is part of a <strong>combined payment</strong>. Saving updates the delivery details for every
              card shipping together in that payment.
            </div>
          )}
          {placed && (
            <div className="rounded-lg border border-out bg-out-soft px-3 py-2.5 text-[13px] text-out">
              This order has already been <strong>placed into production</strong>{order.fulfilled_at ? ` on ${formatDate(order.fulfilled_at)}` : ''}.
              Update it here, then let Stock Control know — they may already have the old address.
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Recipient name" htmlFor="ship-name">
              <Input id="ship-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Who receives the parcel" />
            </Field>
            <Field label="Phone" htmlFor="ship-phone" hint="Couriers (FedEx especially) need a contact number.">
              <Input id="ship-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Contact number" />
            </Field>
          </div>

          <Field label="VAT / EORI number" htmlFor="ship-vat" hint="For EU-bound business orders — smooths the parcel through customs.">
            <Input id="ship-vat" value={customsTaxId} onChange={(e) => setCustomsTaxId(e.target.value)} placeholder="e.g. DE123456789" />
          </Field>

          <Field label="Address line 1" htmlFor="ship-line1">
            <Input id="ship-line1" value={line1} onChange={(e) => setLine1(e.target.value)} placeholder="Street address" />
          </Field>
          <Field label="Address line 2" htmlFor="ship-line2" hint="Optional.">
            <Input id="ship-line2" value={line2} onChange={(e) => setLine2(e.target.value)} placeholder="Flat, suite, etc." />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Town / city" htmlFor="ship-city">
              <Input id="ship-city" value={city} onChange={(e) => setCity(e.target.value)} />
            </Field>
            <Field label="County / region" htmlFor="ship-region" hint="Optional.">
              <Input id="ship-region" value={region} onChange={(e) => setRegion(e.target.value)} />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Postcode / ZIP" htmlFor="ship-postcode">
              <Input id="ship-postcode" value={postcode} onChange={(e) => setPostcode(e.target.value)} />
            </Field>
            <Field label="Country" htmlFor="ship-country">
              <select id="ship-country" value={country} onChange={(e) => setCountry(e.target.value)} className={selectClass}>
                <option value="">Choose…</option>
                {SHIP_COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>{c.name}</option>
                ))}
              </select>
            </Field>
          </div>

          {countryChanged && (
            <div className="rounded-lg border border-low bg-low-soft px-3 py-2.5 text-[13px] text-ink">
              You’re changing the delivery country{originalCountry ? ` from ${countryLabel(originalCountry)}` : ''} to{' '}
              {countryLabel(country)}. This redirects the parcel only — shipping, VAT and any US tariff were charged for
              the original destination and aren’t recalculated. Check the difference by eye for a big move.
            </div>
          )}

          {/* Weight — only when this card thickness hasn't a real weight yet. */}
          {canEditWeight && (
            <Field
              label="Card weight (grams)"
              htmlFor="ship-weight"
              hint={`No real weight is recorded for ${materialWeightLabel || 'this card'}. Setting it here updates it for every card of that material and thickness (same as the Card weights tab), so international shipping rates correctly.`}
            >
              <div className="w-40">
                <Input
                  id="ship-weight"
                  type="number"
                  min="1"
                  step="1"
                  value={weightStr}
                  onChange={(e) => setWeightStr(e.target.value)}
                  placeholder="grams per card"
                />
              </div>
            </Field>
          )}

          {error && <div className="rounded-lg border border-out bg-out-soft px-3 py-2 text-[13px] text-out">{error}</div>}
        </div>

        <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-line-soft bg-white px-6 py-4">
          <ButtonGhost onClick={onClose} disabled={saving}>Cancel</ButtonGhost>
          <ButtonCoral onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save delivery details'}</ButtonCoral>
        </div>
      </div>
    </Modal>
  )
}
