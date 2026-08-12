// The Edit-order modal (?path=/order-edit — EditOrderModal mounted on a fixture
// Full Colour Plastic order: GBP, three thicknesses of which one carries no
// price tier, gloss/matte finish, single recipient). ?state= picks the order:
// `agreed` (default), `grid`, `agreed-novariants`.
//
// These specs exist because of a real incident. On ORD-96E1B49E8B (The
// Rowborough Estate, Full Colour Plastic, £329 agreed price) the finish was
// wrong and there was no way to fix it from the app at all — it took a direct
// database write. Two independent gates hid it: the modal never FETCHED the
// material options on a custom-quote order, and separately never RENDERED the
// picker. PR #615 had already made the opposite decision on the create side
// (OrderBuilderModal shows the finish on an agreed price, because the finish is
// captured and sent to production either way), and this modal — the correction
// path for exactly those orders — kept the old hidden behaviour.
//
// The real failures these specs exist to catch:
//
//   1. either picker vanishing again on an agreed price. That is the incident,
//      and it is invisible until someone needs to correct a live order.
//   2. the finish being SHOWN but inert — a picker whose selection never moves
//      is no better than no picker, and worse because it looks like it worked.
//   3. the price-tier filter being lifted for GRID orders along with the
//      picker. A grid order's price keys on the variant, so offering one with
//      no tier in this currency would create an unpayable order.
//   4. the newly-reachable "Choose…" state silently NULLing the thickness.
//      update-order writes material_variant_id unconditionally, so saving on
//      the unresolved placeholder would take the shipping weight and the Xero
//      item code with it — a data loss that only became possible when the
//      picker became visible.
//   5. that same guard over-firing on the one shape where a variant-less order
//      is legitimate (a material with no variants at all), which would block
//      an unrelated edit — correcting the agreed total — behind a pick the
//      designer cannot make.
//
// The mock backend is stateless: update-order resolves { ok: true }, so a save
// can be asserted as far as the modal's own success state, never a refetch.
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

// The modal is done saving when its footer swaps for the success actions.
const doneButton = (page: Page) => page.getByRole('button', { name: /^done$/i })

test.describe('edit order — agreed price', () => {
  test.beforeEach(async ({ page }) => {
    // The harness lives at /verify-harness/index.html — "/" on this port is
    // the real app against a dead backend, a trap that has cost time before.
    await page.goto('/verify-harness/index.html?path=/order-edit')
    await expect(page.getByRole('dialog', { name: /edit order/i })).toBeVisible()
    // The catalogue reads have landed once the variant picker renders.
    await expect(page.locator('#edit-order-variant')).toBeVisible()
  })

  test('both spec pickers are reachable, alongside the agreed total', async ({ page }) => {
    const errors = collectHarnessErrors(page)

    // THE REGRESSION. The finish pills must be here on an agreed price — this
    // is the control the incident needed and could not reach.
    await expect(page.getByRole('button', { name: 'Gloss' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Matte' })).toBeVisible()

    // And the thickness, which on an agreed price still sets the shipping
    // weight and the production spec. All three variants are offered: an
    // agreed price does no tier lookup, so the unpriced one is not filtered
    // out the way it is on a grid order below.
    const variantPicker = page.locator('#edit-order-variant')
    await expect(variantPicker.locator('option')).toHaveCount(4) // Choose… + 3
    await expect(variantPicker).toHaveValue('oe-mv-680')

    // The agreed total is still here — the spec pickers are additions to this
    // form, not a replacement for the field that was already on it.
    await expect(page.locator('#edit-order-custom')).toHaveValue('329')

    expect(errors).toEqual([])
  })

  test('the finish picker actually moves, and the edit saves', async ({ page }) => {
    // A visible-but-inert picker would satisfy the test above while leaving the
    // incident unfixed, so assert the selection genuinely moves: the two pills
    // start with different treatments and swap them on click.
    const gloss = page.getByRole('button', { name: 'Gloss' })
    const matte = page.getByRole('button', { name: 'Matte' })
    const glossBefore = await bg(gloss)
    const matteBefore = await bg(matte)
    expect(glossBefore).not.toBe(matteBefore)

    // Polled: the pills animate (transition-colors), so the computed value
    // settles a beat after the click.
    await matte.click()
    await expect.poll(() => bg(matte)).toBe(glossBefore)
    await expect.poll(() => bg(gloss)).toBe(matteBefore)

    // And the form accepts it. Save reaching the success state is what proves
    // the corrected finish leaves the modal at all.
    await page.getByRole('button', { name: /save changes/i }).click()
    await expect(doneButton(page)).toBeVisible()
  })

  test('the thickness can be corrected too', async ({ page }) => {
    const variantPicker = page.locator('#edit-order-variant')
    await variantPicker.selectOption({ label: '420 micron' })
    await expect(variantPicker).toHaveValue('oe-mv-420')

    await page.getByRole('button', { name: /save changes/i }).click()
    await expect(doneButton(page)).toBeVisible()
  })

  test('saving on the unresolved "Choose…" is refused rather than clearing the thickness', async ({ page }) => {
    // The select's empty placeholder is a deliberate unresolved state (it is
    // what the order's variant falls back to when it has been deactivated).
    // Saving from there would write a null variant, so the modal must block —
    // the assertion that matters is that the success state is NOT reached.
    await page.locator('#edit-order-variant').selectOption('')
    await page.getByRole('button', { name: /save changes/i }).click()

    await expect(doneButton(page)).toHaveCount(0)
    await expect(page.locator('#edit-order-variant')).toBeVisible()
    // …and that it says why. A silent refusal reads as a broken button, so the
    // error box (matched on its design-token classes, not its copy) must show.
    await expect(page.locator('.bg-out-soft')).toBeVisible()

    // Re-picking clears the block, so the guard is a gate and not a dead end.
    await page.locator('#edit-order-variant').selectOption('oe-mv-760')
    await page.getByRole('button', { name: /save changes/i }).click()
    await expect(doneButton(page)).toBeVisible()
  })
})

test.describe('edit order — grid price (?state=grid)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/verify-harness/index.html?path=/order-edit&state=grid')
    await expect(page.getByRole('dialog', { name: /edit order/i })).toBeVisible()
    await expect(page.locator('#edit-order-variant')).toBeVisible()
  })

  test('is unchanged: both pickers, and only variants that carry a price tier', async ({ page }) => {
    const errors = collectHarnessErrors(page)

    // A grid order prices from tiers, so the unpriced 760 micron must stay out
    // of the list — one fewer choice than the agreed-price order above, which
    // is what proves the tier filter survived the picker being lifted.
    const variantPicker = page.locator('#edit-order-variant')
    await expect(variantPicker.locator('option')).toHaveCount(3) // Choose… + 2
    await expect(variantPicker.locator('option[value="oe-mv-760"]')).toHaveCount(0)

    // The finish was always available here; it must not have been lost in the
    // rearrangement that made it available on an agreed price too.
    await expect(page.getByRole('button', { name: 'Gloss' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Matte' })).toBeVisible()

    // No agreed-total box on a catalogue-priced order.
    await expect(page.locator('#edit-order-custom')).toHaveCount(0)

    expect(errors).toEqual([])
  })
})

test.describe('edit order — agreed price, material with no variants (?state=agreed-novariants)', () => {
  test('saves without demanding a pick that cannot be made', async ({ page }) => {
    const errors = collectHarnessErrors(page)
    await page.goto('/verify-harness/index.html?path=/order-edit&state=agreed-novariants')
    await expect(page.getByRole('dialog', { name: /edit order/i })).toBeVisible()

    // Nothing to choose from, so no picker and no pills — and the variant
    // guard must stand down rather than trap an edit of the agreed total.
    await expect(page.locator('#edit-order-variant')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Gloss' })).toHaveCount(0)

    await page.locator('#edit-order-custom').fill('395')
    await page.getByRole('button', { name: /save changes/i }).click()
    await expect(doneButton(page)).toBeVisible()

    expect(errors).toEqual([])
  })
})
