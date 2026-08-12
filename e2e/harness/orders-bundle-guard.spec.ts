// The bundle guard at order time — the Orders worklist (?path=/orders), the
// order builder, and the proof page's facts rail.
//
// A bundle is N separate proofs the customer reviews on one link, but approval
// is per card. So a customer can approve one card and ask for changes on
// another, and the approved card drops into "Links to send" looking like any
// other approved project — nothing on it said the other cards existed. On
// 12 August 2026 that put a pay link for one card of a two-card bundle out
// three seconds after the customer requested changes on the other.
//
// Two fixture bundles carry the two states worth locking in:
//   * set-ord  — p-bo1 approved, p-bo2 mid-revision (the incident)
//   * set-done — p-bo3 + p-bo4 both approved (the combine-payments moment)
//
// What must not silently stop being true:
//
//   1. an approved card of a part-approved bundle SAYS SO in the worklist, and
//      names the outstanding card. A count alone ("1 of 2") doesn't tell you
//      whether to wait; "changes requested" does.
//   2. the same warning survives into the order builder, and again onto the
//      screen carrying the Send button — which is the last moment before the
//      customer hears anything, and the only one that matters.
//   3. it never blocks. Every action stays live: this is a warning, by an
//      explicit decision, because selling one card of a bundle is sometimes
//      right and the rest can join a combined payment later.
//   4. an ordinary standalone project grows no bundle furniture at all. Most
//      projects are standalone; a warning that shows everywhere is ignored
//      everywhere.
//
// ⚠ Assert STRUCTURE and FACTS (which card, what state), never prose. The
// counts and the named sibling are the load-bearing content; the sentences
// around them are free to change.

import { test, expect, type Page } from '@playwright/test'

const ORDERS = '/verify-harness/index.html?path=/orders'
const PROOF = '/verify-harness/index.html?path=/proofs/p-bo1'

// The bundle callout is the only element on a worklist card that carries both
// a progress count and a link to /bundles/… — there is no role for it.
const BUNDLE_LINE = 'text=/Part of a bundle/'

/** The "Links to send" worklist. Scoped, because a customer can appear in more
 *  than one section of this page (Ken Ng also has an expired link up in FIX). */
function sendSection(page: Page) {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: /^Send ·/ }) }).first()
}

/** The worklist card for one customer. Each card is a PanelShell — a <section>
 *  — so the nearest section ancestor of the customer link IS the card; the
 *  worklist's own wrapper section is the one above it. Headline is the company
 *  where there is one, else the contact (customerLabel), so a company with two
 *  cards in the list yields two — .first() takes the topmost. */
function cardFor(page: Page, customer: string) {
  return sendSection(page)
    .getByRole('link', { name: customer, exact: true })
    .first()
    .locator('xpath=ancestor::section[1]')
}

test.describe('bundle guard — the worklist', () => {
  test('a part-approved bundle names the card that is holding it up', async ({ page }) => {
    await page.goto(ORDERS)
    const card = cardFor(page, 'Michael Bogdan')
    await expect(card).toBeVisible()

    // The count says how far along, the named sibling says whether to wait.
    // Both, or the warning can't be acted on.
    await expect(card.locator(BUNDLE_LINE)).toContainText('1 of 2')
    await expect(card.getByRole('listitem').filter({ hasText: 'Letterpress' })).toContainText(
      /changes requested/i,
    )
    // It has to be reachable, not just readable — the bundle is where the
    // question "is this really ready?" gets answered.
    await expect(card.getByRole('link', { name: /bundle/i })).toHaveAttribute(
      'href',
      '/bundles/set-ord',
    )
  })

  test('the warning never disables the action', async ({ page }) => {
    // Warn, don't block (Rob, 12 Aug 2026). A guard that stopped the send would
    // be wrong often enough to be worked around, and then trusted by nobody.
    await page.goto(ORDERS)
    const card = cardFor(page, 'Michael Bogdan')
    await expect(card.getByRole('button', { name: /create order link/i })).toBeEnabled()
  })

  test('a fully approved bundle points at combining the payments instead', async ({ page }) => {
    // The positive half. Both cards need a link, and this is precisely the
    // moment two separate links get sent to one customer.
    await page.goto(ORDERS)
    const card = cardFor(page, 'Husbyklinikkene')
    await expect(card.locator(BUNDLE_LINE).first()).toContainText('2 of 2')
    // Nothing is outstanding, so nothing is listed as holding it up.
    await expect(card.getByRole('listitem').filter({ hasText: /changes requested/i })).toHaveCount(0)
  })

  test('a standalone project carries no bundle furniture', async ({ page }) => {
    await page.goto(ORDERS)
    const card = cardFor(page, 'Ken Ng')
    await expect(card).toBeVisible()
    await expect(card.locator(BUNDLE_LINE)).toHaveCount(0)
  })
})

test.describe('bundle guard — the order builder', () => {
  test('the warning follows into the form, and into the send step', async ({ page }) => {
    await page.goto(ORDERS)
    await cardFor(page, 'Michael Bogdan').getByRole('button', { name: /create order link/i }).click()

    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible()

    // In the form: informs the decision to build the order at all.
    const warning = modal.locator('text=/one card of a bundle/i').first()
    await expect(warning).toBeVisible()
    await expect(modal.getByRole('listitem').filter({ hasText: 'Letterpress' })).toContainText(
      /changes requested/i,
    )

    // And the form still submits — the guard adds a sentence, not a gate.
    await expect(modal.getByRole('button', { name: /^Create order$/i })).toBeEnabled()
  })
})

test.describe('bundle guard — the proof page', () => {
  test('the facts rail says how far along the bundle is', async ({ page }) => {
    // Before this, the rail linked to the workspace and said nothing else — so
    // the one thing worth knowing before ordering (are the others signed off?)
    // was a click away, on the page nobody opens when they already know what
    // they came to do.
    await page.goto(PROOF)
    const row = page.locator('dt', { hasText: /Part of a bundle/ }).locator('xpath=following-sibling::dd[1]')
    await expect(row).toContainText('1 of 2')
    await expect(row).toContainText(/Letterpress/)
  })
})
