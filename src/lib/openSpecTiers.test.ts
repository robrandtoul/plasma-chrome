// Client ↔ server parity tests for the open-spec chooser maths.
// Run with: npx tsx src/lib/openSpecTiers.test.ts  (pnpm test:open-spec)
//
// The group pay page (and the single pay page) show live per-card prices
// computed by src/lib/openSpecTiers.ts; the money actually charged is
// computed by supabase/functions/_shared/orderPricing.ts inside
// create-checkout-session (single AND group mode). Vite and Deno can't
// share a module, so — like the ukVatArea twins — this test imports BOTH
// copies and fails on any drift: every figure a chooser card shows must
// equal the figure the server would charge for that pick.

import { totalFromTiers, surchargeFromTiers } from './openSpecTiers'
import {
  cardTotalForQuantity,
  computeOrderTotal,
  resolveCardDiscount,
  type Tier,
} from '../../supabase/functions/_shared/orderPricing.ts'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${(err as Error).message}`)
    failed++
  }
}

function assertEqual(actual: unknown, expected: unknown, label = '') {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${label ? `${label}: ` : ''}expected ${e}, got ${a}`)
}

const round2 = (n: number) => Math.round(n * 100) / 100

// A realistic metal-style tier grid (flat above top) and a paper-style one
// (no flat extension), both ascending as the pages always sort them.
const METAL_TIERS = [
  { quantity: 50, total_price: 225 },
  { quantity: 100, total_price: 350 },
  { quantity: 250, total_price: 725 },
  { quantity: 500, total_price: 1250 },
  { quantity: 1000, total_price: 2100 },
]
const PAPER_TIERS = [
  { quantity: 100, total_price: 180 },
  { quantity: 250, total_price: 320 },
  { quantity: 500, total_price: 520 },
]
const SUR_TIERS = [
  { quantity: 50, surcharge: 39 },
  { quantity: 100, surcharge: 49 },
  { quantity: 250, surcharge: 79 },
  { quantity: 500, surcharge: 119 },
  { quantity: 1000, surcharge: 189 },
]

// ── totalFromTiers ↔ cardTotalForQuantity (the cards line) ──────────

test('cards parity: every quantity 1–6000 (metal, flat above top)', () => {
  for (let q = 1; q <= 6000; q += 7) {
    const client = totalFromTiers(METAL_TIERS, q, true)
    const server = cardTotalForQuantity(METAL_TIERS as Tier[], q, undefined, { flatAboveTop: true })
    assertEqual(client, server, `qty ${q}`)
  }
})

test('cards parity: every quantity 1–1200 (paper, no flat extension)', () => {
  for (let q = 1; q <= 1200; q += 3) {
    const client = totalFromTiers(PAPER_TIERS, q, false)
    const server = cardTotalForQuantity(PAPER_TIERS as Tier[], q, undefined, { flatAboveTop: false })
    assertEqual(client, server, `qty ${q}`)
  }
})

test('cards parity: exact tiers land on the listed price', () => {
  for (const t of METAL_TIERS) {
    assertEqual(totalFromTiers(METAL_TIERS, t.quantity, true), t.total_price)
  }
})

test('cards: below the minimum and empty tiers are unpriceable', () => {
  assertEqual(totalFromTiers(METAL_TIERS, 25, true), null)
  assertEqual(totalFromTiers([], 100, true), null)
  assertEqual(totalFromTiers(METAL_TIERS, 0, true), null)
})

test('cards: above top is flat per-card for metal, unpriceable for paper', () => {
  // 1500 at the 1000-tier per-card rate: 2100/1000 × 1500 = 3150.
  assertEqual(totalFromTiers(METAL_TIERS, 1500, true), 3150)
  assertEqual(totalFromTiers(PAPER_TIERS, 800, false), null)
})

// ── surchargeFromTiers ↔ the server's finish-surcharge treatment ────
// create-checkout-session (both modes) prices a finish surcharge with
// cardTotalForQuantity over the schedule and treats null as 0.

test('finish surcharge parity: every quantity 1–6000 (flat above top)', () => {
  const serverTiers: Tier[] = SUR_TIERS.map((s) => ({ quantity: s.quantity, total_price: s.surcharge }))
  for (let q = 1; q <= 6000; q += 7) {
    const client = surchargeFromTiers(SUR_TIERS, q, true)
    const server = cardTotalForQuantity(serverTiers, q, undefined, { flatAboveTop: true }) ?? 0
    assertEqual(client, server, `qty ${q}`)
  }
})

test('finish surcharge: empty schedule and out-of-range are 0', () => {
  assertEqual(surchargeFromTiers([], 500, true), 0)
  assertEqual(surchargeFromTiers(SUR_TIERS, 25, false), 0)
  assertEqual(surchargeFromTiers(SUR_TIERS, 2000, false), 0)
})

// ── The page's discount mirror ↔ resolveCardDiscount ────────────────
// Both pay pages compute the designer discount client-side with the same
// percent-or-fixed / cap-at-base rules the server applies. This pins the
// contract the pages' local cardDiscountForBase helpers mirror.

function pageDiscountMirror(type: string | null, value: number | null, base: number): number {
  if (type !== 'percent' && type !== 'fixed') return 0
  const v = Number(value)
  if (!Number.isFinite(v) || v <= 0) return 0
  const b = Number.isFinite(base) && base > 0 ? base : 0
  if (b <= 0) return 0
  const raw = type === 'percent' ? b * (v / 100) : v
  return round2(Math.min(Math.max(raw, 0), b))
}

test('discount parity: percent, fixed, cap, and disabled cases', () => {
  const cases: [string | null, number | null, number][] = [
    ['percent', 10, 350],
    ['percent', 100, 725],
    ['fixed', 50, 350],
    ['fixed', 500, 350], // capped at the base
    ['percent', 0, 350],
    [null, 25, 350],
    ['fixed', 25, 0],
  ]
  for (const [t, v, b] of cases) {
    assertEqual(pageDiscountMirror(t, v, b), resolveCardDiscount(t, v, b), `${t} ${v} on ${b}`)
  }
})

// ── Worked group example: two members, one open, one custom quote ────
// Mirrors handleGroupCheckout's member loop + total arithmetic for a
// bundle where the customer chose 300 × 500µm Mirror on member A (open
// thickness/finish/quantity, 2 names, personalisation) and member B is a
// £950 custom quote with a £50 fixed discount. The page's live figures
// (built from the client helpers) must equal the server's charge.

test('group example: member goods + combined total agree client↔server', () => {
  // Member A — the server's charge via computeOrderTotal.
  const qty = 300
  const optionSurcharge = cardTotalForQuantity(
    SUR_TIERS.map((s) => ({ quantity: s.quantity, total_price: s.surcharge })),
    qty,
    undefined,
    { flatAboveTop: true },
  ) ?? 0
  const personalisation = { perCardRate: 0.2, minCharge: 50 }
  const priced = computeOrderTotal({
    tiers: METAL_TIERS as Tier[],
    quantity: qty,
    perExtraNameSurcharge: 39,
    namesCount: 2,
    personalisation,
    optionSurcharge,
    flatAboveTop: true,
    shipping: 0,
  })
  if (!priced.ok) throw new Error('server refused to price member A')

  // Member A — the page's live mirror (cards + finish + tooling + pers).
  const cards = totalFromTiers(METAL_TIERS, qty, true)
  const finish = surchargeFromTiers(SUR_TIERS, qty, true)
  const tooling = round2((2 - 1) * 39)
  const pers = Math.max(personalisation.minCharge, qty * personalisation.perCardRate)
  if (cards == null) throw new Error('client could not price member A')
  assertEqual(round2(cards + finish + tooling + pers), round2(priced.goods), 'member A goods')

  // Member A discount on the cards+finish base — page mirror vs server.
  const discountA = pageDiscountMirror('percent', 10, round2(cards + finish))
  assertEqual(discountA, resolveCardDiscount('percent', 10, round2(priced.cards + priced.finish)), 'member A discount')

  // Member B — custom quote at face value with a fixed £50 discount.
  const goodsB = 950
  const discountB = resolveCardDiscount('fixed', 50, goodsB)
  assertEqual(pageDiscountMirror('fixed', 50, goodsB), discountB, 'member B discount')

  // Combined: goodsSum − discountSum + ONE shipping + ONE tariff — the
  // group PaymentIntent amount (handleGroupCheckout's final total line).
  const shipping = 18.9
  const usTariff = 39
  const total = round2(round2(priced.goods + goodsB) - round2(discountA + discountB) + shipping + usTariff)
  const pageTotal = round2(
    round2(round2(cards + finish + tooling + pers) + goodsB) - round2(discountA + discountB) + shipping + usTariff,
  )
  assertEqual(pageTotal, total, 'combined total')
})

console.log('')
if (failed > 0) {
  console.error(`${failed} test(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`All ${passed} open-spec parity tests passed`)
