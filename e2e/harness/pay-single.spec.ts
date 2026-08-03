// The single-order pay page (/order/:id?token=…), up to — never including —
// the Stripe card form. js.stripe.com is blocked in the harness, and the
// fixture's create-checkout-session replies with an error, so every state
// asserted here is the client-computed one the customer actually decides on.
//
// What these lock in, and the real failures each exists to catch:
//
//   1. the recap and itemised breakdown are the customer's last look at what
//      they're buying. A page that showed the wrong artwork, dropped a line,
//      or showed a total that isn't the sum of its lines would take money for
//      something the customer didn't agree to. All the figures derive from
//      the fixture price grid in verify-harness/fixtures/pay-pages.ts, and
//      the client maths must mirror the server charge — so a drift here is a
//      drift between what's shown and what's billed.
//   2. open-spec choosers are FORCE-CHOICE: nothing pre-selected, and the pay
//      affordance stays gated until every open dimension is picked. The
//      regression this catches is a customer paying for a thickness or finish
//      they never chose.
//   3. prices re-derive live from the tier grid as picks land. A stale total
//      after a pick is the "shown price ≠ charged price" bug class.
//   4. the US tariff line is included by default, needs an explicit
//      confirmation to remove, and the total tracks it both ways.
//   5. an expired link offers no way to pay; a paid order shows its stamped
//      summary and tracking rail, and no payment affordance.
//
// ⚠ Assert STRUCTURE, never wording. Money figures are fixture data, not copy.

import { test, expect } from '@playwright/test'

// The harness lives at /verify-harness/index.html — "/" on this port is the
// real app against a dead backend, a trap that has cost time before.
const payUrl = (id: string) => `/verify-harness/index.html?path=/order/${id}&token=tok`

test.describe('fixed-spec order (pay-fixed)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(payUrl('pay-fixed'))
    // Two PanelShell <section>s = the payable screen (summary + inputs).
    await expect(page.locator('section')).toHaveCount(2)
  })

  test('the recap shows the approved artwork and the locked spec', async ({ page }) => {
    // The artwork is the trust anchor: one front and one back from the
    // approved version, each expandable. A missing side means the customer is
    // paying against half the design.
    const summary = page.locator('section').first()
    await expect(summary.locator('img[alt="Approved proof artwork"]')).toHaveCount(2)
    await expect(summary.getByRole('button', { name: /front artwork/i })).toBeVisible()
    await expect(summary.getByRole('button', { name: /back artwork/i })).toBeVisible()

    // The locked spec renders from the order's own variant + finish, not from
    // whatever the proof happens to show today. All three are fixture strings.
    const spec = summary.locator('dl')
    await expect(spec.getByText('Stainless Steel', { exact: true })).toBeVisible()
    await expect(spec.getByText('500 micron', { exact: true })).toBeVisible()
    await expect(spec.getByText('Mirror', { exact: true })).toBeVisible()
  })

  test('the itemised breakdown adds up to the shown total', async ({ page }) => {
    // Fixture maths: cards 549 (500µm @ 500) + mirror 60 = £609; tooling
    // (2 names − 1) × £39 = £39; manual shipping £15; total £663. Each line
    // is derived independently by the page from the tier grid, so the total
    // only reads £663 if the whole chain still agrees.
    const summary = page.locator('section').first()
    for (const amount of ['£609', '£39', '£15']) {
      await expect(summary.getByText(amount, { exact: true })).toBeVisible()
    }
    await expect(summary.getByText('£663', { exact: true })).toBeVisible()
    // The pay affordance quotes the same figure — the two are computed by
    // different expressions in the page and must never diverge.
    await expect(page.getByRole('button', { name: /continue/i })).toContainText('£663')
  })

  test('a failed checkout start surfaces inline and leaves the page usable', async ({ page }) => {
    // This order auto-advances to checkout on load; the fixture refuses the
    // create-checkout-session call. The failure must land as an inline alert
    // with the inputs panel still live — a dead end here is an abandoned
    // payment in real life.
    await expect(page.getByRole('alert')).toBeVisible()
    const cta = page.getByRole('button', { name: /continue/i })
    await expect(cta).toBeEnabled()
    await expect(cta).toContainText('£663')
  })

  test('a persisted quantity pre-selects, and changing it re-prices every line', async ({ page }) => {
    // The order carries quantity 500 from an earlier checkout call — a
    // returning customer must see their own pick selected, not a mystery
    // figure they can't change.
    await expect(page.getByRole('button', { name: '500', exact: true })).toHaveAttribute('aria-pressed', 'true')

    // Re-pick 250: cards 299 + mirror 40 = £339; total 339 + 39 + 15 = £393.
    await page.getByRole('button', { name: '250', exact: true }).click()
    const summary = page.locator('section').first()
    await expect(summary.getByText('£339', { exact: true })).toBeVisible()
    await expect(summary.getByText('£393', { exact: true })).toBeVisible()
    // The old total must be gone everywhere, or the page shows two prices.
    await expect(page.getByText('£663')).toHaveCount(0)
  })
})

test.describe('open-spec order (pay-open)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(payUrl('pay-open'))
    await expect(page.locator('section')).toHaveCount(2)
    // Chooser data arrives from the proof graph a beat after the order.
    await expect(page.getByRole('button', { name: /300 micron/ })).toBeVisible()
  })

  test('every chooser renders force-choice with nothing pre-selected', async ({ page }) => {
    // 4 quantity chips + 2 thickness cards + 2 finish cards, all toggleable,
    // none pressed. A default selection here would let a customer pay for a
    // spec they never actually chose.
    await expect(page.locator('button[aria-pressed]')).toHaveCount(8)
    await expect(page.locator('button[aria-pressed="true"]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /continue/i })).toBeDisabled()
  })

  test('the pay affordance stays gated until every choice is made', async ({ page }) => {
    // The load-bearing gate: quantity alone must not unlock it, quantity +
    // thickness must not unlock it — only the full set does.
    const cta = page.getByRole('button', { name: /continue/i })
    await expect(cta).toBeDisabled()

    await page.getByRole('button', { name: '500', exact: true }).click()
    await expect(cta).toBeDisabled()

    await page.getByRole('button', { name: /500 micron/ }).click()
    await expect(cta).toBeDisabled()

    await page.getByRole('button', { name: /^Mirror/ }).click()
    await expect(cta).toBeEnabled()

    // And the picks read back as selected — one per chooser.
    await expect(page.locator('button[aria-pressed="true"]')).toHaveCount(3)
  })

  test('prices re-derive from the tier grid as the picks change', async ({ page }) => {
    // Once a quantity lands, each thickness card prices at THAT quantity from
    // its own tier row (no longer a "from" figure).
    await page.getByRole('button', { name: '500', exact: true }).click()
    await expect(page.getByRole('button', { name: /300 micron/ })).toContainText('£449')
    await expect(page.getByRole('button', { name: /500 micron/ })).toContainText('£549')

    // Full pick: 549 + 60 = £609 (free shipping, so total is goods only).
    const cta = page.getByRole('button', { name: /continue/i })
    await page.getByRole('button', { name: /500 micron/ }).click()
    await page.getByRole('button', { name: /^Mirror/ }).click()
    await expect(cta).toContainText('£609')

    // Change quantity: 299 + 40 = £339. Change thickness: 249 + 40 = £289.
    await page.getByRole('button', { name: '250', exact: true }).click()
    await expect(cta).toContainText('£339')
    await page.getByRole('button', { name: /300 micron/ }).click()
    await expect(cta).toContainText('£289')
  })

  test('the finish premium is priced per quantity, and the base finish carries none', async ({ page }) => {
    await page.getByRole('button', { name: '500', exact: true }).click()
    const mirror = page.getByRole('button', { name: /^Mirror/ })
    await expect(mirror).toContainText('+£60')

    await page.getByRole('button', { name: '250', exact: true }).click()
    await expect(mirror).toContainText('+£40')

    // The base finish must never grow a surcharge, whatever the quantity.
    await expect(page.getByRole('button', { name: /^Natural/ })).not.toContainText('+£')
  })
})

test.describe('US-bound order (pay-us)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(payUrl('pay-us'))
    await expect(page.locator('section')).toHaveCount(2)
  })

  test('the tariff line renders, and opting out removes it from the total', async ({ page }) => {
    // Agreed price $500 + tariff $39 (the settings default) = $539.
    const cta = page.getByRole('button', { name: /continue/i })
    const summary = page.locator('section').first()
    await expect(cta).toContainText('$539')
    await expect(summary.getByText('$500', { exact: true })).toBeVisible()
    await expect(summary.getByText('$39', { exact: true })).toBeVisible()
    await expect(summary.getByText('$539', { exact: true })).toBeVisible()

    // Opt out (two-step: remove, then confirm the consequence). The total
    // must drop by exactly the tariff, and the old figure must not linger.
    await page.getByRole('button', { name: /remove/i }).click()
    await page.getByRole('button', { name: /yes/i }).click()
    await expect(cta).toContainText('$500')
    await expect(page.getByText('$539')).toHaveCount(0)

    // Adding it back restores the original total.
    await page.getByRole('button', { name: /add it back/i }).click()
    await expect(cta).toContainText('$539')
  })

  test('removing the tariff needs an explicit confirmation', async ({ page }) => {
    // The first click must NOT change the charge — it opens a confirm step,
    // and backing out of it leaves the tariff in place. A one-click removal
    // would strand customers with a surprise customs bill.
    const cta = page.getByRole('button', { name: /continue/i })
    await page.getByRole('button', { name: /remove/i }).click()
    await expect(cta).toContainText('$539')

    await page.getByRole('button', { name: /keep/i }).click()
    await expect(cta).toContainText('$539')
    await expect(page.locator('section').first().getByText('$39', { exact: true })).toBeVisible()
  })
})

test.describe('expired link (pay-expired)', () => {
  test('an expired link offers no way to pay', async ({ page }) => {
    // Pricing and shipping move over time — a payable control on a lapsed
    // link would charge a stale price. The expired screen must be inert:
    // no buttons, no inputs, nothing to submit.
    await page.goto(payUrl('pay-expired'))
    await expect(page.getByRole('heading', { name: /expired/i })).toBeVisible()
    await expect(page.getByRole('button')).toHaveCount(0)
    await expect(page.locator('input, select, textarea')).toHaveCount(0)
  })
})

test.describe('paid order (pay-paid)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(payUrl('pay-paid'))
    await expect(page.locator('section')).toHaveCount(2)
  })

  test('the paid summary shows the stamped breakdown, and no payment affordance', async ({ page }) => {
    // Stamped at checkout: cards £609 + tooling £39 + shipping £15 = £663.
    // This is the customer's receipt view — it must reconcile, and it must
    // not offer to take a second payment.
    const summary = page.locator('section').first()
    for (const amount of ['£609', '£39', '£15']) {
      await expect(summary.getByText(amount, { exact: true })).toBeVisible()
    }
    await expect(summary.getByText('£663', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /pay|continue/i })).toHaveCount(0)
    // The delivery address the webhook persisted is shown back.
    await expect(page.getByText(/FX1 2AB/)).toBeVisible()
  })

  test('the tracking rail draws the journey at the projected stage', async ({ page }) => {
    // Granular projection, stage in_production, delivery tracking unknown →
    // the full four-step rail, currently on step 2, with the outbound
    // tracking number shown. A wrong step count or a missing number is the
    // pay page and proof page disagreeing about where the order has got to.
    const rail = page.locator('ol')
    await expect(rail).toHaveCount(1)
    await expect(rail.locator('li')).toHaveCount(4)
    await expect(page.getByText(/2 of 4/)).toBeVisible()
    await expect(page.getByText('TRK-0001')).toBeVisible()
  })
})
