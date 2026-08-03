// The combined pay page (/order/group/:id?token=…), up to — never including —
// the Stripe card form. One page, one payment, several orders: a line per
// member card, per-member choosers for anything the designer left open, one
// combined total. js.stripe.com is blocked in the harness and the fixture's
// create-checkout-session replies with an error, so everything asserted is
// the client-computed state the customer decides on.
//
// What these lock in, and the real failures each exists to catch:
//
//   1. every member gets its own line, and only OPEN members get a chooser.
//      A locked member growing a chooser (or an open one silently pricing
//      itself) would let a customer pay for a spec nobody chose.
//   2. the single combined Pay affordance gates on the open member's full
//      set of choices — the group must not be payable with one card still
//      unresolved, because the server prices every member at checkout.
//   3. the combined total re-derives live as the open member's picks change,
//      from the same fixture tier grid the single pay page uses. A stale
//      total is the "shown price ≠ charged price" bug class, multiplied by
//      however many cards are in the group.
//   4. a failed checkout start lands as an inline alert with the page still
//      usable, not a dead end.
//   5. a paid group renders one stamped line per member plus the combined
//      shipping and discount, reconciling to the total paid, with no payment
//      affordance left anywhere.
//
// Figures derive from verify-harness/fixtures/pay-pages.ts: locked member
// £500 agreed + open member (tier grid: 500µm@500 £549 + Mirror £60) + £20
// combined shipping → £1,129 fully picked.
//
// ⚠ Assert STRUCTURE, never wording. Money figures are fixture data, not copy.

import { test, expect } from '@playwright/test'

const groupUrl = (id: string) => `/verify-harness/index.html?path=/order/group/${id}&token=tok`

test.describe('combined payment, one member open (grp-1)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(groupUrl('grp-1'))
    // Two PanelShell <section>s = the payable screen (summary + inputs).
    await expect(page.locator('section')).toHaveCount(2)
    // The open member's chooser catalogue arrives from its proof graph a
    // beat after the group payload.
    await expect(page.getByRole('button', { name: /300 micron/ })).toBeVisible()
  })

  test('one line per member: the locked card is priced, only the open card gets a chooser', async ({ page }) => {
    const summary = page.locator('section').first()
    // The locked member's line: label from its frozen spec snapshot, priced
    // at its agreed figure. Both are fixture data.
    await expect(summary.getByText('1,000 × Walnut Wood', { exact: true })).toBeVisible()
    await expect(summary.getByText('£500', { exact: true })).toBeVisible()
    // Combined shipping is one line for the whole group.
    await expect(summary.getByText('£20', { exact: true })).toBeVisible()
    // No combined total yet — the open member has no figure until picked.
    await expect(summary.getByText('£1,129', { exact: true })).toHaveCount(0)

    // Exactly one chooser on the page: the open member's quantity type-in.
    // A second one would mean the locked member grew a chooser.
    await expect(page.getByRole('spinbutton')).toHaveCount(1)
    // And the open member's chooser is force-choice: nothing pre-selected.
    await expect(page.locator('button[aria-pressed="true"]')).toHaveCount(0)
  })

  test('the single Pay affordance gates on the open member being fully picked', async ({ page }) => {
    const cta = page.getByRole('button', { name: /continue to payment|choose your options/i })
    await expect(cta).toBeDisabled()

    await page.getByRole('button', { name: '500', exact: true }).click()
    await expect(cta).toBeDisabled()

    await page.getByRole('button', { name: /500 micron/ }).click()
    await expect(cta).toBeDisabled()

    await page.getByRole('button', { name: /^Mirror/ }).click()
    await expect(cta).toBeEnabled()
  })

  test('the combined total updates live as the open member is picked', async ({ page }) => {
    const summary = page.locator('section').first()
    await page.getByRole('button', { name: '500', exact: true }).click()
    await page.getByRole('button', { name: /500 micron/ }).click()
    await page.getByRole('button', { name: /^Mirror/ }).click()

    // Open member line 549 + 60 = £609; combined 500 + 609 + 20 = £1,129.
    await expect(summary.getByText('£609', { exact: true })).toBeVisible()
    await expect(summary.getByText('£1,129', { exact: true })).toBeVisible()

    // Switch finish to the base: member 549, combined £1,069.
    await page.getByRole('button', { name: /^Natural/ }).click()
    await expect(summary.getByText('£1,069', { exact: true })).toBeVisible()

    // Switch quantity: member 299, combined 500 + 299 + 20 = £819.
    await page.getByRole('button', { name: '250', exact: true }).click()
    await expect(summary.getByText('£819', { exact: true })).toBeVisible()
  })

  test('a failed checkout start surfaces inline and leaves the page usable', async ({ page }) => {
    const cta = page.getByRole('button', { name: /continue to payment|choose your options/i })
    await page.getByRole('button', { name: '500', exact: true }).click()
    await page.getByRole('button', { name: /500 micron/ }).click()
    await page.getByRole('button', { name: /^Mirror/ }).click()
    await expect(cta).toBeEnabled()

    // The fixture refuses create-checkout-session; the page must show the
    // failure inline and keep the choices editable rather than dead-ending.
    await cta.click()
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(cta).toBeEnabled()
  })
})

test.describe('paid group (grp-paid)', () => {
  test('the paid screen reconciles member lines, discount and shipping to the total paid', async ({ page }) => {
    // Stamped at checkout: members £439 (400 cards + 39 tooling) and £250
    // (agreed), one member discount £20, combined shipping £25 →
    // 439 + 250 − 20 + 25 = £694. This is the receipt for one payment
    // covering several orders — it must add up, and it must not offer to
    // charge again.
    await page.goto(groupUrl('grp-paid'))
    await expect(page.locator('section')).toHaveCount(2)

    const summary = page.locator('section').first()
    await expect(summary.getByText('£439', { exact: true })).toBeVisible()
    await expect(summary.getByText('£250', { exact: true })).toBeVisible()
    await expect(summary.getByText('-£20', { exact: true })).toBeVisible()
    await expect(summary.getByText('£25', { exact: true })).toBeVisible()
    await expect(summary.getByText('£694', { exact: true })).toBeVisible()

    await expect(page.getByRole('button', { name: /pay|continue|choose/i })).toHaveCount(0)
    // The delivery address the webhook persisted is shown back.
    await expect(page.getByText(/FX1 2AB/)).toBeVisible()
  })
})
