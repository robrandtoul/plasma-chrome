// The Create-order builder (?path=/order-builder — OrderBuilderModal mounted
// on the fixture steel proof: EUR, three thicknesses, three finishes, no
// recipient roster). ?state=custom-proof mounts it on a proof whose VERSION
// is a custom quote.
//
// The Pricing basis (PR #615) is the newest and most entangled control on this
// form: it is a per-ORDER choice layered onto a form that previously only knew
// per-PROOF custom quotes, and everything it changes sits below it. The real
// failures these specs exist to catch:
//
//   1. the Catalogue / Agreed pills disappearing, or Agreed becoming the
//      default — an order silently billed at a face-value figure nobody typed,
//      or the "we settled a price by email" case losing its only route through
//      the form again.
//   2. picking Agreed price NOT revealing the total box — the designer has no
//      way to enter the figure, and submit() would reject with no visible
//      input to fix.
//   3. the open-spec "customer chooses at checkout" affordances SURVIVING the
//      switch to an agreed price. A fixed total cannot be repriced by the
//      customer's pick, so leaving the pills up would create an order whose
//      checkout contradicts its billing.
//   4. a typed agreed figure LEAKING back after switching to Catalogue and
//      back — it reads as something already saved, which the code explicitly
//      clears on the switch.
//   5. the custom-quote PROOF losing its forced state — pills appearing would
//      offer a catalogue price that never existed for that proof.
//   6. the ordinary field flow breaking: locking a quantity must reveal the
//      quantity input, and locking the thickness must reveal the variant
//      picker, or the designer can choose a mode they cannot then satisfy.
//
// The mock backend is stateless — nothing here submits; every assertion is
// about the form's own state machine.
//
// ⚠ Assert STRUCTURE, never wording. Pill selection is asserted by comparing
// computed backgrounds before/after, never by pinning a colour.

import { test, expect, type Page } from '@playwright/test'

function collectHarnessErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' && m.text().includes('[harness] uncaught render error')) {
      errors.push(m.text())
    }
  })
  return errors
}

const bg = (locator: import('@playwright/test').Locator) =>
  locator.evaluate((el) => getComputedStyle(el).backgroundColor)

test.describe('order builder — standard proof', () => {
  test.beforeEach(async ({ page }) => {
    // The harness lives at /verify-harness/index.html — "/" on this port is
    // the real app against a dead backend, a trap that has cost time before.
    await page.goto('/verify-harness/index.html?path=/order-builder')
    await expect(page.getByRole('dialog', { name: /create order/i })).toBeVisible()
    // The variants have loaded once the thickness open-spec pill renders.
    await expect(page.getByRole('button', { name: /customer chooses at checkout/i })).toBeVisible()
  })

  test('renders clean with the fixture context and both pricing pills', async ({ page }) => {
    const errors = collectHarnessErrors(page)

    // The sticky header names the customer, material and currency — all
    // fixture data, so a mis-wire (wrong proof, wrong currency) shows here.
    const dialog = page.getByRole('dialog', { name: /create order/i })
    await expect(dialog.getByText(/husbyklinikkene/i)).toBeVisible()
    await expect(dialog.getByText(/stainless steel/i).first()).toBeVisible()
    await expect(dialog.getByText(/EUR/).first()).toBeVisible()

    // The pricing basis offers exactly the two choices.
    await expect(page.getByRole('button', { name: /catalogue price/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /agreed price/i })).toBeVisible()

    // And the form is submittable chrome-wise: a live Create button next to
    // Cancel (validation happens on click, not by disabling).
    await expect(page.getByRole('button', { name: /create order/i })).toBeEnabled()
    await expect(page.getByRole('button', { name: /cancel/i })).toBeVisible()

    expect(errors).toEqual([])
  })

  test('catalogue price is the default and the highlight swaps on click', async ({ page }) => {
    const catalogue = page.getByRole('button', { name: /catalogue price/i })
    const agreed = page.getByRole('button', { name: /agreed price/i })

    // Catalogue selected ⇒ no agreed-total box, and the two pills carry
    // different treatments (selected vs not).
    await expect(page.locator('#order-custom-total')).toHaveCount(0)
    const catBefore = await bg(catalogue)
    const agrBefore = await bg(agreed)
    expect(catBefore).not.toBe(agrBefore)

    // Clicking Agreed swaps which pill carries the selected treatment —
    // compared against the other pill's previous colour rather than a pinned
    // value, so a palette change can't fail this. Polled: the pills animate
    // (transition-colors), so the computed value settles a beat after click.
    await agreed.click()
    await expect(page.locator('#order-custom-total')).toBeVisible()
    await expect.poll(() => bg(agreed)).toBe(catBefore)
    await expect.poll(() => bg(catalogue)).toBe(agrBefore)
  })

  test('agreed price reveals the total box and strips the customer-chooses affordances below it', async ({ page }) => {
    // Catalogue default: the thickness is offered to the customer (the fixture
    // steel has 3 thickness variants), so the Option field shows the
    // at-checkout pills and the pay-page sentence naming all three, and the
    // "Their last order" section is on offer.
    await expect(page.getByRole('button', { name: /customer chooses at checkout/i })).toHaveCount(1)
    await expect(page.getByText(/300 micron \/ 500 micron \/ 800 micron/)).toBeVisible()
    await expect(page.getByRole('button', { name: /add their last order/i })).toBeVisible()
    await expect(page.locator('#order-variant')).toHaveCount(0)

    await page.getByRole('button', { name: /agreed price/i }).click()

    // The total box appears where the pills are — everything else it changes
    // is BELOW it.
    await expect(page.locator('#order-custom-total')).toBeVisible()

    // A fixed total can't be repriced by the customer's pick, so the
    // at-checkout affordance goes, the designer gets a plain variant picker
    // (all three thicknesses — it still sets weight + production spec), and
    // the last-order guidance section (which only serves pay-page choosers)
    // disappears.
    await expect(page.getByRole('button', { name: /customer chooses at checkout/i })).toHaveCount(0)
    const variantPicker = page.locator('#order-variant')
    await expect(variantPicker).toBeVisible()
    await expect(variantPicker.locator('option')).toHaveCount(4) // Choose… + 3 thicknesses
    await expect(page.getByRole('button', { name: /add their last order/i })).toHaveCount(0)
  })

  test('switching back to catalogue clears the typed figure', async ({ page }) => {
    // A stale number reappearing on a second switch reads as something already
    // saved — the exact leak the switch handler exists to prevent.
    await page.getByRole('button', { name: /agreed price/i }).click()
    await page.locator('#order-custom-total').fill('750')
    await expect(page.locator('#order-custom-total')).toHaveValue('750')

    await page.getByRole('button', { name: /catalogue price/i }).click()
    await expect(page.locator('#order-custom-total')).toHaveCount(0)

    await page.getByRole('button', { name: /agreed price/i }).click()
    await expect(page.locator('#order-custom-total')).toHaveValue('')
  })

  test('locking the quantity reveals the quantity input', async ({ page }) => {
    // The fixture proof has no recipient roster (namesCount 0), so the locked
    // path is the single total input. Before locking, the form carries no
    // numeric input at all; after, exactly the one.
    await expect(page.getByRole('spinbutton')).toHaveCount(0)
    await page.getByRole('button', { name: /^lock a quantity$/i }).click()
    await expect(page.getByRole('spinbutton')).toHaveCount(1)

    // And the mode is reversible.
    await page.getByRole('button', { name: /^customer chooses$/i }).click()
    await expect(page.getByRole('spinbutton')).toHaveCount(0)
  })

  test('locking the thickness swaps the pay-page sentence for a picker, and the finish pills select', async ({ page }) => {
    // Thickness: "Lock it now" replaces the they'll-choose sentence with the
    // variant picker, pre-selecting nothing (three real choices).
    await page.getByRole('button', { name: /lock it now/i }).click()
    const variantPicker = page.locator('#order-variant')
    await expect(variantPicker).toBeVisible()
    await expect(variantPicker.locator('option')).toHaveCount(4)
    await variantPicker.selectOption({ label: '500 micron' })
    await expect(variantPicker).toHaveValue('mv-500')

    // Finish: the three catalogue finishes render as pills with the base one
    // (Natural — the proof's single offered code) selected; clicking another
    // moves the selected treatment to it.
    const natural = page.getByRole('button', { name: 'Natural' })
    const brushed = page.getByRole('button', { name: 'Brushed' })
    await expect(natural).toBeVisible()
    await expect(brushed).toBeVisible()
    await expect(page.getByRole('button', { name: 'Mirror' })).toBeVisible()
    const naturalBefore = await bg(natural)
    const brushedBefore = await bg(brushed)
    expect(naturalBefore).not.toBe(brushedBefore)
    // Polled: the pills animate (transition-colors), so the computed value
    // settles a beat after the click.
    await brushed.click()
    await expect.poll(() => bg(brushed)).toBe(naturalBefore)
    await expect.poll(() => bg(natural)).toBe(brushedBefore)
  })
})

test.describe('order builder — custom-quote proof (?state=custom-proof)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/verify-harness/index.html?path=/order-builder&state=custom-proof')
    await expect(page.getByRole('dialog', { name: /create order/i })).toBeVisible()
  })

  test('no pricing pills at all — the total box shows on its own', async ({ page }) => {
    const errors = collectHarnessErrors(page)

    // A custom-quote proof has no basis choice to offer: there was never a
    // price grid to bill from. Pills appearing here would offer a catalogue
    // price that doesn't exist.
    await expect(page.locator('#order-custom-total')).toBeVisible()
    await expect(page.getByRole('button', { name: /catalogue price/i })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /agreed price/i })).toHaveCount(0)

    // No open-spec affordance anywhere either — the spec is a designer pick
    // (the picker still renders, because thickness sets weight + production
    // spec even on an agreed price).
    await expect(page.getByRole('button', { name: /customer chooses at checkout/i })).toHaveCount(0)
    await expect(page.locator('#order-variant')).toBeVisible()
    await expect(page.locator('#order-variant').locator('option')).toHaveCount(4)

    // The quantity is LOCKED on an agreed price: the pay page's quantity
    // chooser is disabled whenever custom_quote_total is set, so "Customer
    // chooses" would ship an order with no quantity recorded or shown
    // anywhere — the mode snaps to locked, the open pill is disabled, and
    // the quantity input is already revealed.
    await expect(page.getByRole('button', { name: /^customer chooses$/i })).toBeDisabled()
    await expect(page.getByRole('button', { name: /^lock a quantity$/i })).toBeEnabled()
    await expect(page.getByPlaceholder('e.g. 250')).toBeVisible()

    expect(errors).toEqual([])
  })
})
