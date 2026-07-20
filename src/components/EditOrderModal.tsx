import { useEffect, useState } from 'react'
import Modal from './Modal'
import { Field, Input, ButtonCoral, ButtonGhost } from '../design'
import { supabase } from '../lib/supabase'
import { customerOrderUrl } from '../lib/customerOrderUrl'

// Edit an existing, UNPAID order link in place (the sibling to OrderBuilderModal).
//
// Used when a customer changes their mind about the spec — most often the
// thickness — AFTER the pay link has gone out. Editing here keeps the SAME link
// (no cancellation email, no fresh link), and the new spec flows through to the
// price automatically: an online order is priced server-side at pay time
// (create-checkout-session reads the order row on every Pay click), so changing
// the variant/quantity here changes what the customer is charged next time they
// pay.
//
// Scope is deliberately narrow — only the fields a customer can legitimately
// change before paying: thickness/variant, finish, quantity (+ per-person
// split), the agreed total on a custom-quote order, and the per-order card
// discount. Currency, payment method, shipping treatment and the Xero binding
// are kept as they were (shipping recomputes from the new variant's weight at
// checkout under the unchanged treatment). Like the builder, this prices
// nothing itself — it just captures the spec and calls update-order.
//
// Only a 'sent' production order is editable; the modal guards on load and the
// edge function guards again (conditional on status='sent') so a customer
// paying mid-edit can't have a paid order overwritten.

type Currency = 'GBP' | 'EUR' | 'USD'
type CardDiscountType = 'none' | 'percent' | 'fixed'

const CARD_DISCOUNT_OPTIONS: { value: CardDiscountType; label: string }[] = [
  { value: 'none', label: 'No discount' },
  { value: 'percent', label: '% off' },
  { value: 'fixed', label: 'Fixed amount off' },
]

interface VariantOption {
  id: string
  display_name: string
  // 'thickness' | 'ink_count' | 'finish' | 'default'. ink_count + finish are
  // defined by the approved artwork and can't change at order time; thickness
  // (and default) is a substrate choice the customer can still change — so only
  // those stay an editable picker.
  variant_type: string | null
}

interface MaterialOptionRow {
  id: string
  display_name: string
  is_base: boolean
}

// The order fields this modal reads + edits.
interface OrderEdit {
  proof_id: string
  status: string
  order_kind: string | null
  currency: Currency
  custom_quote_total: number | null
  material_variant_id: string | null
  material_option_id: string | null
  quantity: number | null
  names_count: number
  person_quantities: { name: string; quantity: number }[] | null
  card_discount_type: CardDiscountType | null
  card_discount_value: number | null
  card_discount_reason: string | null
  token: string
}

interface EditOrderModalProps {
  orderId: string
  customerLabel: string | null
  materialDisplay: string | null
  onClose: () => void
  onUpdated?: () => void
}

export default function EditOrderModal({
  orderId,
  customerLabel,
  materialDisplay,
  onClose,
  onUpdated,
}: EditOrderModalProps) {
  // ── Load ───────────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [currency, setCurrency] = useState<Currency>('GBP')
  const [isCustomQuote, setIsCustomQuote] = useState(false)

  // Editable state.
  const [variants, setVariants] = useState<VariantOption[]>([])
  const [variantId, setVariantId] = useState<string | null>(null)
  // The current variant is locked (read-only) when it's artwork-defined.
  const [variantLocked, setVariantLocked] = useState(false)
  const [materialOptions, setMaterialOptions] = useState<MaterialOptionRow[]>([])
  const [optionId, setOptionId] = useState<string | null>(null)
  const [optionLabel, setOptionLabel] = useState('Finish')

  const [quantityMode, setQuantityMode] = useState<'open' | 'locked'>('locked')
  const [quantity, setQuantity] = useState('')
  const [personNames, setPersonNames] = useState<string[]>([])
  const [personQty, setPersonQty] = useState<Record<string, string>>({})

  const [customQuoteTotal, setCustomQuoteTotal] = useState('')
  const [cardDiscountType, setCardDiscountType] = useState<CardDiscountType>('none')
  const [cardDiscountValue, setCardDiscountValue] = useState('')
  const [cardDiscountReason, setCardDiscountReason] = useState('')

  const [namesCount, setNamesCount] = useState(1)

  const [dirty, setDirty] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    void (async () => {
      const { data, error: orderErr } = await supabase
        .from('orders')
        .select(
          'proof_id, status, order_kind, currency, custom_quote_total, material_variant_id, material_option_id, quantity, names_count, person_quantities, card_discount_type, card_discount_value, card_discount_reason, token',
        )
        .eq('id', orderId)
        .maybeSingle()
      if (cancelled) return
      if (orderErr || !data) {
        setLoadError('Could not load this order. Close and try again.')
        setLoading(false)
        return
      }
      const o = data as unknown as OrderEdit
      if (o.status !== 'sent') {
        setLoadError('This order can no longer be edited — it may have been paid or cancelled.')
        setLoading(false)
        return
      }
      if ((o.order_kind ?? 'production') !== 'production') {
        setLoadError('Prototype and reprint orders can’t be edited here.')
        setLoading(false)
        return
      }

      const cur = o.currency
      const custom = o.custom_quote_total != null
      setToken(o.token)
      setCurrency(cur)
      setIsCustomQuote(custom)
      setNamesCount(o.names_count ?? 1)
      setOptionId(o.material_option_id ?? null)
      setCustomQuoteTotal(custom ? String(o.custom_quote_total) : '')
      setCardDiscountType((o.card_discount_type as CardDiscountType | null) ?? 'none')
      setCardDiscountValue(o.card_discount_value != null ? String(o.card_discount_value) : '')
      setCardDiscountReason(o.card_discount_reason ?? '')

      // Quantity mode + values.
      const hasSplit = Array.isArray(o.person_quantities) && o.person_quantities.length > 0
      setQuantityMode(o.quantity != null || hasSplit ? 'locked' : 'open')
      if (o.quantity != null && !hasSplit) setQuantity(String(o.quantity))

      // Per-person split: prefer the order's stored split; else, for a
      // multi-name order, fall back to the proof's current-version names.
      if (hasSplit) {
        const names = (o.person_quantities ?? []).map((p) => p.name)
        setPersonNames(names)
        setPersonQty(Object.fromEntries((o.person_quantities ?? []).map((p) => [p.name, String(p.quantity)])))
      } else if ((o.names_count ?? 1) > 1) {
        const { data: pv } = await supabase
          .from('proof_versions')
          .select('names')
          .eq('proof_id', o.proof_id)
          .eq('is_current', true)
          .maybeSingle()
        if (!cancelled) {
          const names = Array.isArray(pv?.names) ? (pv!.names as string[]).filter(Boolean) : []
          setPersonNames(names)
        }
      }

      // Variant + finish pickers (grid orders only). A custom-quote order keeps
      // its variant for the production spec but isn't priced from tiers, so it
      // doesn't need the picker here.
      let materialId: string | null = null
      let currentVariantType: string | null = null
      if (o.material_variant_id) {
        const { data: v } = await supabase
          .from('material_variants')
          .select('material_id, variant_type')
          .eq('id', o.material_variant_id)
          .maybeSingle()
        materialId = (v?.material_id as string | null) ?? null
        currentVariantType = (v?.variant_type as string | null) ?? null
      }
      setVariantId(o.material_variant_id ?? null)
      // Lock the variant read-only when it's artwork-defined (ink count / finish
      // type) — changing those would mean a different proof.
      setVariantLocked(currentVariantType === 'ink_count' || currentVariantType === 'finish')

      if (!custom && materialId) {
        // Active variants priced in this currency. A per-variant head count
        // (no rows transferred) is exact regardless of tier volume, unlike a
        // fetch-all that hits supabase-js's 1000-row cap (mirrors the builder).
        const { data: vs } = await supabase
          .from('material_variants')
          .select('id, display_name, sort_order, variant_type')
          .eq('material_id', materialId)
          .eq('is_active', true)
          .order('sort_order')
        const rows = (vs ?? []) as { id: string; display_name: string | null; variant_type: string | null }[]
        const checks = await Promise.all(
          rows.map(async (r) => {
            const { count } = await supabase
              .from('price_tiers')
              .select('id', { count: 'exact', head: true })
              .eq('material_variant_id', r.id)
              .eq('currency', cur)
            return { id: r.id, has: (count ?? 0) > 0 }
          }),
        )
        if (cancelled) return
        const priced = new Set(checks.filter((c) => c.has).map((c) => c.id))
        setVariants(
          rows
            .filter((r) => priced.has(r.id))
            .map((r) => ({ id: r.id, display_name: r.display_name ?? 'Option', variant_type: r.variant_type })),
        )

        // Finish options (metal Natural/Brushed/Mirror etc.) + the picker label.
        const [optsRes, matRes] = await Promise.all([
          supabase.from('material_options').select('id, display_name, is_base, sort_order').eq('material_id', materialId).order('sort_order'),
          supabase.from('materials').select('option_label').eq('id', materialId).maybeSingle(),
        ])
        if (cancelled) return
        setMaterialOptions(
          (optsRes.data ?? []).map((m) => ({ id: m.id as string, display_name: (m.display_name as string) ?? 'Option', is_base: !!m.is_base })),
        )
        if (matRes.data?.option_label) setOptionLabel(matRes.data.option_label as string)
      }

      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [orderId])

  const usePerPersonSplit = namesCount > 1 && personNames.length > 1

  async function submit() {
    setError(null)

    // Resolve the quantity payload.
    let quantityValue: number | null = null
    let personQuantitiesPayload: { name: string; quantity: number }[] | null = null
    if (quantityMode === 'locked') {
      // A multi-name order locked to a single total (no per-person split) is
      // ambiguous for production — mirror OrderBuilderModal and refuse it. This
      // only bites if the recipient names failed to load; reopening reloads them.
      if (namesCount > 1 && personNames.length <= 1) {
        setError('Recipient names haven’t loaded — close and reopen the order to lock per-person quantities, or leave it as “Customer chooses”.')
        return
      }
      if (usePerPersonSplit) {
        const entries = personNames.map((n) => ({ name: n, quantity: parseInt(personQty[n] ?? '', 10) }))
        if (entries.some((e) => !Number.isInteger(e.quantity) || e.quantity <= 0)) {
          setError('Enter a quantity (greater than zero) for each person, or let the customer choose.')
          return
        }
        personQuantitiesPayload = entries
        quantityValue = entries.reduce((acc, e) => acc + e.quantity, 0)
      } else {
        const q = Number(quantity)
        if (!Number.isInteger(q) || q <= 0) {
          setError('Enter a whole quantity greater than zero, or let the customer choose.')
          return
        }
        quantityValue = q
      }
    }

    let customQuoteValue: number | null = null
    if (isCustomQuote) {
      // Blank must not save as £0 — see the matching guard in OrderBuilderModal.
      const raw = customQuoteTotal.trim()
      const c = Number(raw)
      if (raw === '' || !Number.isFinite(c) || c <= 0) {
        setError('This is a custom-quote order — enter the agreed total.')
        return
      }
      customQuoteValue = c
    } else if (!variantId) {
      setError('Choose which option (thickness) this order is for.')
      return
    }

    let cardDiscountValueParsed: number | null = null
    if (cardDiscountType !== 'none') {
      const v = Number(cardDiscountValue)
      if (!Number.isFinite(v) || v <= 0) {
        setError(cardDiscountType === 'percent' ? 'Enter a card discount percentage above 0.' : 'Enter a card discount amount above 0.')
        return
      }
      if (cardDiscountType === 'percent' && v > 100) {
        setError('Enter a card discount percentage between 0 and 100%.')
        return
      }
      cardDiscountValueParsed = v
    }

    setSubmitting(true)
    try {
      const { data, error: fnError } = await supabase.functions.invoke<{ ok?: boolean; error?: string }>(
        'update-order',
        {
          body: {
            order_id: orderId,
            material_variant_id: variantId,
            material_option_id: optionId ?? undefined,
            quantity: quantityValue,
            person_quantities: personQuantitiesPayload,
            custom_quote_total: customQuoteValue,
            card_discount_type: cardDiscountType,
            card_discount_value: cardDiscountValueParsed,
            card_discount_reason: cardDiscountReason.trim() || undefined,
          },
        },
      )
      if (fnError || !data || !data.ok) {
        // A non-2xx leaves data null + the friendly message on the error body.
        let msg = (data as { error?: string } | null)?.error ?? null
        const ctx = (fnError as { context?: Response } | null)?.context
        if (!msg && ctx && typeof ctx.json === 'function') {
          try { const b = await ctx.json(); if (b && typeof b.error === 'string') msg = b.error } catch { /* not JSON */ }
        }
        setError(msg ?? 'Could not update the order. Please try again.')
        return
      }
      onUpdated?.()
      setDone(true)
    } catch {
      setError('Could not update the order. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  async function copyLink() {
    if (!token) return
    try {
      await navigator.clipboard.writeText(customerOrderUrl(orderId, token))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard blocked — leave the button as-is.
    }
  }

  // Backdrop / Esc / Cancel route through here so an accidental dismissal can't
  // silently bin edits. Once saved (done) there's nothing to lose.
  function handleDismiss() {
    if (done || !dirty) { onClose(); return }
    if (window.confirm('Discard your changes to this order?')) onClose()
  }

  const selectClass =
    'h-[38px] w-full rounded-[8px] border border-line bg-surface px-3 text-sm text-ink ' +
    'focus:outline-2 focus:outline-offset-1 focus:border-[var(--c-brand)] focus:outline-[var(--c-brand)]'

  return (
    <Modal
      open
      onClose={handleDismiss}
      ariaLabel="Edit order"
      panelClassName="w-full max-w-lg md:max-h-[88vh] overflow-y-auto rounded-2xl bg-white shadow-xl"
    >
      {done ? (
        // ── Success ────────────────────────────────────────────────
        <div className="p-6">
          <h2 className="text-lg font-semibold text-ink">Order updated</h2>
          <p className="mt-2 text-sm text-ink-soft">
            The customer’s existing pay link still works and now reflects these changes — you don’t need to send a new one.
          </p>
          <div className="mt-3 rounded-lg border border-low bg-low-soft px-3 py-2.5 text-[13px] text-ink">
            If they already had the pay page open, ask them to refresh it before paying so they see the updated price.
          </div>
          <div className="mt-5 flex items-center justify-end gap-2">
            <ButtonGhost onClick={copyLink}>{copied ? 'Copied' : 'Copy link'}</ButtonGhost>
            <ButtonCoral onClick={onClose}>Done</ButtonCoral>
          </div>
        </div>
      ) : (
        <div>
          {/* Sticky header */}
          <div className="sticky top-0 z-10 border-b border-line-soft bg-white px-6 pt-6 pb-4">
            <h2 className="text-lg font-semibold text-ink">Edit order</h2>
            <p className="mt-1 text-sm text-ink-soft">
              {customerLabel ? `For ${customerLabel}. ` : ''}
              {materialDisplay ?? 'Material'} · {currency}
              {namesCount > 1 ? ` · ${namesCount} people` : ''}
            </p>
          </div>

          <div className="px-6 py-5" onChange={() => setDirty(true)}>
            {loading ? (
              <p className="text-sm text-ink-mute">Loading order…</p>
            ) : loadError ? (
              <div className="rounded-lg border border-out bg-out-soft px-3 py-2.5 text-[13px] text-out">{loadError}</div>
            ) : (
              <div className="space-y-5">
                {/* Variant / thickness — grid orders only. */}
                {!isCustomQuote && (
                  <Field label="Option" htmlFor="edit-order-variant" hint="Which variant (e.g. thickness) this order is for — sets the price used at checkout.">
                    {variants.length === 0 ? (
                      <p className="text-sm text-ink-mute">No priced options found for this material/currency.</p>
                    ) : variantLocked ? (
                      <p className="text-sm text-ink">
                        {variants.find((v) => v.id === variantId)?.display_name ?? '—'}
                        <span className="text-ink-mute"> · fixed by the approved artwork</span>
                      </p>
                    ) : (
                      // Always a select (even for a single option) so the shown
                      // choice can't drift from variantId — e.g. when the order's
                      // original variant was deactivated and a different one is now
                      // the only priced option, the value falls to "Choose…" and the
                      // designer must re-pick rather than be shown the wrong variant.
                      <select
                        id="edit-order-variant"
                        value={variantId ?? ''}
                        onChange={(e) => { setVariantId(e.target.value || null); setDirty(true) }}
                        className={selectClass}
                      >
                        <option value="">Choose…</option>
                        {variants.map((v) => (
                          <option key={v.id} value={v.id}>{v.display_name}</option>
                        ))}
                      </select>
                    )}
                  </Field>
                )}

                {/* Finish (material option) — metals etc. */}
                {!isCustomQuote && materialOptions.length > 0 && (
                  <Field label={optionLabel} asLabel={false} hint={`Which ${optionLabel.toLowerCase()} the customer is ordering — the price includes any surcharge at checkout.`}>
                    <div className="flex flex-wrap gap-2">
                      {materialOptions.map((o) => (
                        <button
                          key={o.id}
                          type="button"
                          onClick={() => { setOptionId(o.id); setDirty(true) }}
                          className={[
                            'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                            optionId === o.id ? 'bg-ink text-on-ink' : 'bg-surface text-ink-soft ring-1 ring-line hover:bg-canvas',
                          ].join(' ')}
                        >
                          {o.display_name}
                        </button>
                      ))}
                    </div>
                  </Field>
                )}

                {/* Custom quote total — custom-quote orders only. */}
                {isCustomQuote && (
                  <Field label="Agreed total" htmlFor="edit-order-custom" hint="The agreed price for this custom-quote order, in the order’s currency.">
                    <Input
                      id="edit-order-custom"
                      type="number"
                      min="0"
                      step="0.01"
                      value={customQuoteTotal}
                      onChange={(e) => { setCustomQuoteTotal(e.target.value); setDirty(true) }}
                    />
                  </Field>
                )}

                {/* Quantity */}
                <Field label="Quantity" asLabel={false} hint="Let the customer choose on the pay-page, or lock a specific quantity.">
                  <div className="flex flex-wrap gap-2">
                    {([['open', 'Customer chooses'], ['locked', 'Lock a quantity']] as const).map(([m, label]) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => { setQuantityMode(m); setDirty(true) }}
                        className={[
                          'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                          quantityMode === m ? 'bg-ink text-on-ink' : 'bg-surface text-ink-soft ring-1 ring-line hover:bg-canvas',
                        ].join(' ')}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {quantityMode === 'locked' && (
                    namesCount > 1 && !usePerPersonSplit ? (
                      <p className="mt-3 text-[13px] text-out">
                        Couldn’t load the recipient names for the per-person split. Close and reopen the order to set per-person quantities, or leave it as “Customer chooses”.
                      </p>
                    ) : usePerPersonSplit ? (
                      <div className="mt-3 space-y-2">
                        <p className="text-[13px] text-ink-soft">How many cards for each person:</p>
                        {personNames.map((n) => (
                          <div key={n} className="flex w-full items-center justify-between gap-3">
                            <span title={n} className="min-w-0 flex-1 truncate text-sm text-ink">{n}</span>
                            {/* Fixed-width wrapper: the design-system Input is `w-full`
                                by default, which (in Tailwind v4) beats a `w-28` passed
                                on the element and would stretch the box across the whole
                                row, collapsing the name to nothing. Constrain the width
                                on the wrapper instead so the name stays visible. */}
                            <div className="w-28 shrink-0">
                              <Input
                                aria-label={`Quantity for ${n}`}
                                type="number"
                                min="1"
                                step="1"
                                className="text-right"
                                value={personQty[n] ?? ''}
                                onChange={(e) => { setPersonQty((prev) => ({ ...prev, [n]: e.target.value })); setDirty(true) }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-3 w-40">
                        <Input
                          aria-label="Quantity"
                          type="number"
                          min="1"
                          step="1"
                          value={quantity}
                          onChange={(e) => { setQuantity(e.target.value); setDirty(true) }}
                        />
                      </div>
                    )
                  )}
                </Field>

                {/* Card discount */}
                <Field label="Card discount" asLabel={false} hint="An optional discount on the cards, tooling and personalisation subtotal — applied at checkout against the new price.">
                  <div className="flex flex-wrap gap-2">
                    {CARD_DISCOUNT_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => { setCardDiscountType(opt.value); setDirty(true) }}
                        className={[
                          'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                          cardDiscountType === opt.value ? 'bg-ink text-on-ink' : 'bg-surface text-ink-soft ring-1 ring-line hover:bg-canvas',
                        ].join(' ')}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  {cardDiscountType !== 'none' && (
                    <div className="mt-3 space-y-2">
                      <Input
                        aria-label={cardDiscountType === 'percent' ? 'Discount percentage' : 'Discount amount'}
                        type="number"
                        min="0"
                        step={cardDiscountType === 'percent' ? '1' : '0.01'}
                        className="w-40"
                        placeholder={cardDiscountType === 'percent' ? '% off' : `Amount off (${currency})`}
                        value={cardDiscountValue}
                        onChange={(e) => { setCardDiscountValue(e.target.value); setDirty(true) }}
                      />
                      <Input
                        aria-label="Discount reason"
                        type="text"
                        placeholder="Reason (optional)"
                        value={cardDiscountReason}
                        onChange={(e) => { setCardDiscountReason(e.target.value); setDirty(true) }}
                      />
                    </div>
                  )}
                </Field>

                <p className="text-[12px] text-ink-mute">
                  Shipping, currency and payment method stay as they were — shipping recalculates automatically at checkout for the new spec. The customer keeps the same pay link.
                </p>

                {error && (
                  <div className="rounded-lg border border-out bg-out-soft px-3 py-2 text-[13px] text-out">{error}</div>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-line-soft bg-white px-6 py-4">
            <ButtonGhost onClick={handleDismiss} disabled={submitting}>Cancel</ButtonGhost>
            <ButtonCoral onClick={() => void submit()} disabled={submitting || loading || !!loadError}>
              {submitting ? 'Saving…' : 'Save changes'}
            </ButtonCoral>
          </div>
        </div>
      )}
    </Modal>
  )
}
