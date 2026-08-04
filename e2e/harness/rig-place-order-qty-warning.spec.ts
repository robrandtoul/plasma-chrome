// The Qty-line warning on the place-order review message editor
// (?path=/orders/o-blanks/place — OrderReviewPage, src/lib/handoffQty.ts).
//
// The real failure this exists to catch is the Thornton 403957 incident
// (2026-08-04): the reviewer edited the "Qty:" line inside the hand-off
// message from 1,000 to 2,200 instead of using the Spoilage overs field, so
// the supplier email said 2,200 while the Stock Control job, handoff_payload
// and supplier_overs all recorded 1,000. Since Phase 3 the wording is
// deliberately free, so the guard is an amber notice under the message box —
// never a validation gate — shown only when the edited message carries a Qty
// line whose number disagrees with the preview's real supplier quantity.
//
// What must stay true:
//
//   1. rewriting the Qty number surfaces the notice — silence here is how the
//      incident happened;
//   2. the notice NEVER gates Confirm — the wording is free by design, and a
//      warning that blocks becomes a validation gate nobody asked for;
//   3. an edit that leaves the Qty line alone stays silent — a notice that
//      fires on ordinary rewording teaches reviewers to ignore it;
//   4. Reset (or putting the number back) clears it — the notice tracks the
//      live text, not a sticky flag.
//
// The o-blanks rig is used because its fixture summary carries
// supplierQuantity (1,000) on both routes; the notice is the page's only
// [role="status"] amber block. ⚠ Assert STRUCTURE, never wording — the
// numbers asserted are fixture data and values this spec itself types in.

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

const qtyNotice = (page: Page) => page.locator('[role="status"].bg-low-soft')
const messageBox = (page: Page) => page.locator('main').locator('textarea').first()

async function editQtyLine(page: Page, from: string, to: string) {
  const box = messageBox(page)
  const value = await box.inputValue()
  expect(value).toContain(from)
  await box.fill(value.replace(from, to))
}

test.describe('place-order review — the Qty line in the message is only words', () => {
  test.beforeEach(async ({ page }) => {
    // The harness lives at /verify-harness/index.html — "/" on this port is
    // the real app against a dead backend, a trap that has cost time before.
    await page.goto('/verify-harness/index.html?path=/orders/o-blanks/place')
    await expect(page.getByRole('heading', { name: /place order/i })).toBeVisible()
    // The preview has landed once the fixture customer is on screen.
    await expect(page.getByText(/apex dental/i).first()).toBeVisible()
  })

  test('rewriting the Qty number warns amber — and never gates Confirm', async ({ page }) => {
    const errors = collectHarnessErrors(page)

    // The generated note matches its own summary, so no notice at rest.
    await expect(qtyNotice(page)).toHaveCount(0)

    // The incident edit: the number in the message, not the overs field.
    await editQtyLine(page, 'Qty: 1000', 'Qty: 2200')

    // Exactly one notice, naming the number the message now claims and the
    // number the order actually records (both are data, not copy).
    const notice = qtyNotice(page)
    await expect(notice).toHaveCount(1)
    await expect(notice).toContainText('2,200')
    await expect(notice).toContainText('1,000')

    // Advisory by design: the reviewer owns the wording, so Confirm stays
    // enabled with the notice on screen.
    await expect(page.getByRole('button', { name: /confirm & post note/i })).toBeEnabled()

    // Reset returns to the generated text, and the notice goes with it.
    await page.getByRole('button', { name: /^reset$/i }).click()
    await expect(qtyNotice(page)).toHaveCount(0)
    await expect(messageBox(page)).toHaveValue(/Qty: 1000/)

    expect(errors).toEqual([])
  })

  test('an edit that leaves the Qty line alone stays silent', async ({ page }) => {
    const box = messageBox(page)
    const value = await box.inputValue()
    await box.fill(`${value}\n\nPlease call when the batch is ready.`)

    // The message is dirty (Reset is offered) but the Qty still agrees, so
    // there is nothing to warn about.
    await expect(page.getByRole('button', { name: /^reset$/i })).toBeVisible()
    await expect(qtyNotice(page)).toHaveCount(0)
  })

  test('fires on the supplier route too, reads a typed thousands comma, and clears when the number is put back', async ({ page }) => {
    // Walk out of the blanks arrangement to the normal supplier email.
    await page
      .locator('div[class*="in-stock"]')
      .filter({ hasText: 'Blanks from order' })
      .getByRole('button', { name: /order its own blanks/i })
      .click()
    await expect(page.getByRole('button', { name: /confirm & email supplier/i })).toBeVisible()

    // The 403957 edit was typed WITH a thousands comma — the helper must read
    // "1,500" as 1500, not bail at the comma.
    await editQtyLine(page, 'Qty: 1000', 'Qty: 1,500')
    const notice = qtyNotice(page)
    await expect(notice).toHaveCount(1)
    await expect(notice).toContainText('1,500')
    await expect(page.getByRole('button', { name: /confirm & email supplier/i })).toBeEnabled()

    // Putting the real number back clears it live — no Reset needed.
    await editQtyLine(page, 'Qty: 1,500', 'Qty: 1000')
    await expect(qtyNotice(page)).toHaveCount(0)
  })
})
