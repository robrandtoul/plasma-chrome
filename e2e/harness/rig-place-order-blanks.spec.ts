// The combined-supplier-batches review flow (?path=/orders/o-blanks/place —
// OrderReviewPage against the o-blanks / o-thornton fixture pair, migrations
// 000382/000383, PR #628).
//
// o-blanks is a paid foiling order whose 1,000 base cards ride the 2,200-card
// Solopress batch already placed under sibling order o-thornton (403957). The
// mock plays the STORED choice back when the preview asks with no explicit
// blanks field, so the rig loads straight into the active in-house state; the
// undo link sends an explicit null and lands on the normal supplier route,
// where the collapsed disclosure is the only way back in.
//
// The real failures these specs exist to catch:
//
//   1. the stored choice not playing back — a page that quietly reverts to a
//      supplier email orders Solopress a duplicate 1,000-card batch, the
//      exact double-order the feature exists to prevent (confirm fails closed
//      server-side, so the other drift direction strands the order instead —
//      bad either way, and this screen is the only place a reviewer sees it).
//   2. the provenance line leaving the workshop note — what's shown is what
//      goes out, and an in-house job without its "do not order more blanks"
//      line loses the one instruction that stops a second batch being made.
//   3. the undo or the disclosure path dying — the picker is the only way
//      INTO the arrangement and the undo the only way OUT, so either breaking
//      strands the designer on whichever route the page loaded with.
//   4. the batch arithmetic going wrong — source + overs = batch, and the
//      spare-after-both figure, are the reviewer's check that one batch
//      really covers both orders' quantities.
//   5. the amber "short" warning not firing when the batch can't cover both
//      (silence reads as covered), or — worse — gating Confirm: the warning
//      is advisory by design, never a block.
//
// ⚠ Assert STRUCTURE, never wording — the values asserted below are fixture
// DATA (order numbers, quantities, and arithmetic derived from them), which
// only change when someone deliberately edits the mock.

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

// The blanks summary card is the page's green (in-stock-token) block that
// headlines the batch-carrying order. The class alone isn't unique — the
// artwork-check card borrows the same tint when a report comes back clear —
// hence the text anchor on the card's own first line.
const blanksCard = (page: Page) =>
  page.locator('div[class*="in-stock"]').filter({ hasText: 'Blanks from order' })

test.describe('place-order review — blanks from another order (o-blanks)', () => {
  test.beforeEach(async ({ page }) => {
    // The harness lives at /verify-harness/index.html — "/" on this port is
    // the real app against a dead backend, a trap that has cost time before.
    await page.goto('/verify-harness/index.html?path=/orders/o-blanks/place')
    await expect(page.getByRole('heading', { name: /place order/i })).toBeVisible()
    // The preview has landed once the fixture customer is on screen.
    await expect(page.getByText(/apex dental/i).first()).toBeVisible()
  })

  test('loads straight into the active blanks state: green card, in-house route, no supplier machinery', async ({ page }) => {
    const errors = collectHarnessErrors(page)
    const main = page.locator('main')

    // The stored choice plays back with no interaction: exactly one summary
    // card, naming the batch-carrying order and whose project it is.
    const card = blanksCard(page)
    await expect(card).toHaveCount(1)
    await expect(card).toContainText('Blanks from order 403957')
    await expect(card).toContainText('Thornton Dental & Implant Centre')

    // An in-house hand-off, not a supplier email: the route pill, the
    // post-note confirm, and no supplier select anywhere on the page.
    await expect(main.getByText('In-house order', { exact: true })).toBeVisible()
    await expect(main.getByText('Supplier order', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /confirm & post note/i })).toBeEnabled()
    await expect(page.getByRole('button', { name: /confirm & email supplier/i })).toHaveCount(0)
    await expect(main.getByRole('combobox')).toHaveCount(0)

    // The provenance is IN the note the workshop reads, not just on the
    // summary card — the note is the record, the card is the scan aid.
    await expect(main.locator('textarea').first()).toHaveValue(/Base cards: no separate supplier order/)
    await expect(main.locator('textarea').first()).toHaveValue(/403957/)

    // The way back out is offered on the card itself.
    await expect(card.getByRole('button', { name: /order its own blanks from the supplier instead/i })).toBeVisible()

    expect(errors).toEqual([])
  })

  test('the green card carries the batch arithmetic, ending in the spare-after-both line', async ({ page }) => {
    const card = blanksCard(page)

    // The batch total and who is making it…
    await expect(card).toContainText('2,200 blanks')
    await expect(card).toContainText('Solopress')

    // …and what's left once BOTH orders' cards come out of it: 2,200 against
    // 1,000 + 1,000 leaves 200 spare for finishing spoilage. Healthy batch,
    // so the amber short-warning block must not render inside the card.
    await expect(card).toContainText('1,000 + 1,000')
    await expect(card).toContainText('200 spare')
    await expect(card.locator('.bg-low-soft')).toHaveCount(0)
  })

  test('the undo walks back to a normal supplier order: Solopress picker, email confirm, collapsed disclosure', async ({ page }) => {
    const errors = collectHarnessErrors(page)
    const main = page.locator('main')

    await blanksCard(page).getByRole('button', { name: /order its own blanks/i }).click()

    // The route flips: supplier pill, email confirm, post-note confirm gone.
    await expect(main.getByText('Supplier order', { exact: true })).toBeVisible()
    await expect(main.getByText('In-house order', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /confirm & email supplier/i })).toBeEnabled()
    await expect(page.getByRole('button', { name: /confirm & post note/i })).toHaveCount(0)

    // The supplier picker appears, offering the fixture supplier.
    const picker = main.getByRole('combobox')
    await expect(picker).toHaveCount(1)
    await expect(picker.locator('option').filter({ hasText: 'Solopress' })).toHaveCount(1)

    // The green card is gone, and the disclosure is offered COLLAPSED: the
    // toggle is on screen, the candidate list is not (it's an opt-in for the
    // rare combined-batch case, not furniture on every supplier order).
    await expect(blanksCard(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: /base cards already covered by another order/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /order 403957/i })).toHaveCount(0)

    expect(errors).toEqual([])
  })

  test('expanding the disclosure offers the o-thornton batch, and picking it restores the arrangement', async ({ page }) => {
    // Walk out first — the disclosure only exists on the supplier route.
    await blanksCard(page).getByRole('button', { name: /order its own blanks/i }).click()
    await page.getByRole('button', { name: /base cards already covered by another order/i }).click()

    // Exactly one candidate: the placed same-material sibling, described with
    // the arithmetic a designer needs to recognise the batch — quantity plus
    // overs equals the batch, and who is making it.
    const candidate = page.getByRole('button', { name: /order 403957/i })
    await expect(candidate).toHaveCount(1)
    await expect(candidate).toContainText('Thornton Dental & Implant Centre')
    await expect(candidate).toContainText('1,000 + 1,200 overs = 2,200 blanks from Solopress')

    // Picking it re-previews straight back into the active state: green card,
    // in-house confirm, supplier machinery gone again.
    await candidate.click()
    await expect(blanksCard(page)).toContainText('Blanks from order 403957')
    await expect(page.getByRole('button', { name: /confirm & post note/i })).toBeEnabled()
    await expect(page.locator('main').getByRole('combobox')).toHaveCount(0)
  })
})

test.describe('place-order review — short batch (&blanksShort=1)', () => {
  test('a batch that cannot cover both orders warns amber — advisory, never gating Confirm', async ({ page }) => {
    // The flag makes the mock report the Thornton batch at 1,800 (fewer
    // overs), which 1,000 + 1,000 overruns by 200: spare_after_both < 0.
    await page.goto('/verify-harness/index.html?path=/orders/o-blanks/place&blanksShort=1')
    await expect(page.getByText(/apex dental/i).first()).toBeVisible()

    // Still the active arrangement — a short batch changes the advice, not
    // the route.
    const card = blanksCard(page)
    await expect(card).toContainText('Blanks from order 403957')
    await expect(card).toContainText('1,800')

    // The amber block replaces the spare line, naming the shortfall.
    const warning = card.locator('.bg-low-soft')
    await expect(warning).toHaveCount(1)
    await expect(warning).toContainText('200 short')
    await expect(card).not.toContainText('spare for finishing spoilage')

    // Advisory by design: a short batch is checked with the supplier, it does
    // not block the reviewer from placing.
    await expect(page.getByRole('button', { name: /confirm & post note/i })).toBeEnabled()
  })
})
