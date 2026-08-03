// The customer-page post-approval surfaces, on their standalone rigs:
//
//   ?path=/approved-order-status — the approved card's order-status footer
//   (ApprovedOrderStatus + OrderProgressStrip, migrations 000370/000371/000375)
//   in all nine labelled states, under the real .customer-accent scope.
//
//   ?path=/reorder-panel — the "Need more?" panel (000372) in its five states,
//   plus the forward panel (000374) that replaces it once the reorder exists.
//
// The step-count logic is the load-bearing thing here. DPD has never once
// reported a delivery (0 of 122 on live), so a DPD parcel gets a THREE-step
// rail that COMPLETES, while FedEx keeps the fourth step it can actually
// reach. The real failures these specs exist to catch:
//
//   1. the rail going back to a fixed four steps — most customers (DPD is two
//      thirds of volume) would again be parked forever under a final step
//      that can never light up, which reads as a personal failure of THEIR
//      order.
//   2. a terminal DPD rail rendering INCOMPLETE — the journey has ended and
//      the rail must say so, or "Shipped" sits next to a bar stuck at 2/3.
//   3. the dispatch date leaking onto a still-travelling FedEx parcel (whose
//      question is "where is it", not "when did it leave"), or vanishing from
//      the terminal card where it is the one fact on offer (000375).
//   4. states with no journey (awaiting payment, tracking off) growing a rail
//      with nothing behind it, or the no-order card growing a status footer.
//   5. the reorder panel taking money-shaped input it must not: the sending
//      state staying interactive (double submits), an acknowledged state
//      keeping its form (double asks), or the error state losing the form
//      (no retry).
//   6. the forward panel losing its link to the reorder proof — the whole
//      point of 000374 is that the bookmarked page points forward.
//
// ⚠ Assert STRUCTURE, never wording: step counts come from the rails' own
// "Step N of M" accessible names, completeness from node colours compared
// against each other (never pinned), dates from fixture data.

import { test, expect, type Page, type Locator } from '@playwright/test'

function collectHarnessErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' && m.text().includes('[harness] uncaught render error')) {
      errors.push(m.text())
    }
  })
  return errors
}

const bg = (locator: Locator) => locator.evaluate((el) => getComputedStyle(el).backgroundColor)

// A rail is complete when its last node carries the same fill as its first
// (the first node is always reached). Compared, never pinned to a hex.
async function railIsComplete(rail: Locator): Promise<boolean> {
  const nodes = rail.locator('li')
  const first = await bg(nodes.first())
  const last = await bg(nodes.last())
  return first === last
}

test.describe('approved card order status (?path=/approved-order-status)', () => {
  test.beforeEach(async ({ page }) => {
    // The harness lives at /verify-harness/index.html — "/" on this port is
    // the real app against a dead backend, a trap that has cost time before.
    await page.goto('/verify-harness/index.html?path=/approved-order-status')
    await expect(page.locator('.bg-in-stock-soft')).toHaveCount(9)
  })

  test('renders clean: nine cards, eight status footers, six rails with the expected step geometry', async ({ page }) => {
    const errors = collectHarnessErrors(page)

    // Every status footer carries exactly one mono label, so counting them
    // counts the footers: 8 of the 9 states have one (the no-order card is
    // byte-for-byte the plain approved card).
    await expect(page.locator('p.font-mono')).toHaveCount(8)
    const cards = page.locator('.bg-in-stock-soft')
    await expect(cards.nth(0).locator('p.font-mono')).toHaveCount(0)

    // Six states have a journey to draw. The rails' own accessible names are
    // the step geometry: FedEx keeps four steps, DPD gets three, and the two
    // pre-dispatch paid states sit at 1/4 and 2/4 of the full journey.
    await expect(page.getByRole('group')).toHaveCount(6)
    await expect(page.getByRole('group', { name: 'Step 1 of 4' })).toHaveCount(1)
    await expect(page.getByRole('group', { name: 'Step 2 of 4' })).toHaveCount(1)
    await expect(page.getByRole('group', { name: 'Step 3 of 4' })).toHaveCount(1)
    await expect(page.getByRole('group', { name: 'Step 3 of 3' })).toHaveCount(2)
    await expect(page.getByRole('group', { name: 'Step 4 of 4' })).toHaveCount(1)

    // States with no journey must not draw one: awaiting payment (card 2) and
    // paid-with-tracking-off (card 3) get a footer but no rail.
    await expect(cards.nth(1).locator('p.font-mono')).toHaveCount(1)
    await expect(cards.nth(1).getByRole('group')).toHaveCount(0)
    await expect(cards.nth(2).locator('p.font-mono')).toHaveCount(1)
    await expect(cards.nth(2).getByRole('group')).toHaveCount(0)

    expect(errors).toEqual([])
  })

  test('a travelling FedEx parcel draws four steps with the last one unreached; DPD and delivered rails complete', async ({ page }) => {
    // FedEx, on its way: 4 nodes, and the last one is NOT filled like the
    // first — the journey has a step left (Delivered) that it can reach.
    const fedex = page.getByRole('group', { name: 'Step 3 of 4' })
    await expect(fedex.locator('li')).toHaveCount(4)
    expect(await railIsComplete(fedex)).toBe(false)

    // DPD, shipped: 3 nodes and COMPLETE — the carrier never reports
    // delivery, so dispatch is where this journey honestly ends. Both DPD
    // cards (with and without a dispatch stamp) draw the same finished rail.
    const dpdRails = page.getByRole('group', { name: 'Step 3 of 3' })
    for (const i of [0, 1]) {
      const rail = dpdRails.nth(i)
      await expect(rail.locator('li')).toHaveCount(3)
      expect(await railIsComplete(rail), `DPD rail ${i} should be complete`).toBe(true)
    }

    // Delivered: the full four steps, all reached.
    const delivered = page.getByRole('group', { name: 'Step 4 of 4' })
    await expect(delivered.locator('li')).toHaveCount(4)
    expect(await railIsComplete(delivered)).toBe(true)
  })

  test('the dispatch date appears on the terminal DPD card only', async ({ page }) => {
    const cards = page.locator('.bg-in-stock-soft')

    // Terminal DPD with a stamp (card 7): the past-tense line carries the
    // fixture dispatch date, formatted long-form (000375).
    const dpdWithDate = cards.filter({ has: page.getByRole('group', { name: 'Step 3 of 3' }) })
    await expect(dpdWithDate).toHaveCount(2)
    await expect(dpdWithDate.nth(0)).toContainText('24 June 2026')

    // Terminal DPD with NO stamp (card 8): still past tense, but no date is
    // invented — the card carries no June date at all. ('Signed off 24 July'
    // is the card chrome, hence the month-level check.)
    await expect(dpdWithDate.nth(1)).not.toContainText('June')

    // A still-travelling FedEx parcel is never dated — its question is
    // "where is it", not "when did it leave".
    const fedexCard = cards.filter({ has: page.getByRole('group', { name: 'Step 3 of 4' }) })
    await expect(fedexCard).toHaveCount(1)
    await expect(fedexCard).not.toContainText('June')
  })
})

test.describe('reorder panel (?path=/reorder-panel)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/verify-harness/index.html?path=/reorder-panel')
    // 5 panel states + the forward panel.
    await expect(page.locator('section')).toHaveCount(6)
  })

  test('idle offers the two-question form; sending disables all of it', async ({ page }) => {
    const errors = collectHarnessErrors(page)
    const sections = page.locator('section')

    // Idle: exactly two inputs (quantity + optional note — the honeypot is
    // aria-hidden and must not surface) and one live submit. No link: this
    // panel asks, it never carries a payment path.
    const idle = sections.nth(0)
    await expect(idle.getByRole('textbox')).toHaveCount(2)
    for (const i of [0, 1]) await expect(idle.getByRole('textbox').nth(i)).toBeEnabled()
    await expect(idle.getByRole('button')).toHaveCount(1)
    await expect(idle.getByRole('button')).toBeEnabled()
    await expect(idle.getByRole('link')).toHaveCount(0)

    // Sending: everything locks so it cannot be double-submitted.
    const sending = sections.nth(1)
    await expect(sending.getByRole('textbox')).toHaveCount(2)
    for (const i of [0, 1]) await expect(sending.getByRole('textbox').nth(i)).toBeDisabled()
    await expect(sending.getByRole('button')).toBeDisabled()

    expect(errors).toEqual([])
  })

  test('acknowledged states drop the form entirely; the failed state keeps it with a live retry', async ({ page }) => {
    const sections = page.locator('section')

    // Sent (nth 2) and already-asked-on-reload (nth 3): the whole form is
    // replaced by a static acknowledgement — no inputs to ask again with, no
    // button, and no link (a request was recorded, nothing more is promised
    // in interactive form).
    for (const i of [2, 3]) {
      const s = sections.nth(i)
      await expect(s.getByRole('textbox')).toHaveCount(0)
      await expect(s.getByRole('button')).toHaveCount(0)
      await expect(s.getByRole('link')).toHaveCount(0)
    }

    // Failed (nth 4): the error is announced (role=status) and the form stays
    // usable — a customer whose ask didn't land must be able to try again.
    const failed = sections.nth(4)
    await expect(failed.getByRole('status')).toBeVisible()
    await expect(failed.getByRole('textbox')).toHaveCount(2)
    for (const i of [0, 1]) await expect(failed.getByRole('textbox').nth(i)).toBeEnabled()
    await expect(failed.getByRole('button')).toBeEnabled()
  })

  test('the forward panel replaces the ask with a dated link to the reorder project', async ({ page }) => {
    // Once the reorder proof exists the slot holds a pointer, not another
    // invitation to ask (they are mutually exclusive by construction —
    // canRequestReorder goes false the moment a link exists). The rig renders
    // it last.
    const forward = page.locator('section').nth(5)

    // A real link (middle-click must work) to the fixture reorder proof's own
    // customer page…
    await expect(forward.getByRole('link')).toHaveCount(1)
    await expect(forward.getByRole('link')).toHaveAttribute('href', '/p/p-a1')

    // …dated from the fixture request stamp, with no form controls: this
    // panel forwards, it does not ask again.
    await expect(forward).toContainText('20 July 2026')
    await expect(forward.getByRole('textbox')).toHaveCount(0)
    await expect(forward.getByRole('button')).toHaveCount(0)
  })
})
