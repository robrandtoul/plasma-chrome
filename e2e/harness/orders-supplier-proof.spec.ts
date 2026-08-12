// The supplier proof holding pen on the Orders page (?path=/orders), migration
// 000409 — the fourth stage of an order's life.
//
// A supplier order used to end at PLACE: we emailed QX, the card dropped into
// Recently ordered, and the project was closed off. But QX always reply with
// their own internal proof for us to approve, and that step lived only in Help
// Scout. So if they never received the order, or forgot to reply, nothing told
// us — we found out a fortnight later when the cards didn't ship.
//
// Five fixture orders (`sp-*` in verify-harness/mock-supabase.ts) carry one pen
// state each. What follows locks in the things that can silently stop being true:
//
//   1. a placed supplier order is ALWAYS visible somewhere. The whole feature is
//      "stop orders vanishing off the page the moment they're emailed", so a row
//      appearing in no section at all is the original bug, restored.
//   2. an unapproved proof keeps its order OUT of Recently ordered. That archive
//      reads as "done"; a card sitting in it while a supplier waits is exactly
//      the lie the pen exists to prevent.
//   3. a supplier who has gone quiet past the threshold lands in FIX, not in the
//      collapsed Waiting block — and a supplier who is merely being normal (the
//      median reply is two hours) does NOT, or the section cries wolf daily.
//   4. a RE-proof — a reply that postdates an approval — comes back into CHECK.
//      QX routinely send a corrected proof after we've signed off; a one-way
//      door would ship the superseded artwork.
//   5. the states are mutually exclusive on screen. One order in two sections is
//      the count-vs-list drift this page has been bitten by before.
//
// ⚠ Assert STRUCTURE, never wording. Section headings locate a section (there is
// no other handle); references identify a row. Nothing asserts prose.

import { test, expect, type Page } from '@playwright/test'

const ORDERS = '/verify-harness/index.html?path=/orders'

// Fixture references, one per pen state. The reference is the only stable,
// user-visible identifier a row carries in every section it can appear in.
const CHECK_REF = 'ORD-SP-CHECK'
const REVISED_REF = 'ORD-SP-REVISED'
const AWAITING_REF = 'ORD-SP-AWAITING'
const OVERDUE_REF = 'ORD-SP-OVERDUE'
const APPROVED_REF = 'ORD-SP-APPROVED'

function section(page: Page, name: RegExp) {
  return page.locator('section').filter({ has: page.getByRole('heading', { name }) })
}

/** Open the two collapsed sections so a "where is this row?" assertion sees the
 *  whole page. Waiting and Recently ordered are closed by default.
 *
 *  Targeted by name and re-queried per section rather than looping over
 *  `getByRole('button', { expanded: false })`: clicking the first re-renders the
 *  list, which invalidates the remaining handles, so the second never opened —
 *  and the only symptom was rows appearing to be missing from the page. */
async function expandAll(page: Page) {
  for (const name of [/^Waiting ·/i, /^Recently ordered ·/i]) {
    const btn = page.getByRole('button', { name }).first()
    if (await btn.count() === 0) continue
    if ((await btn.getAttribute('aria-expanded')) === 'false') await btn.click()
    await expect(btn).toHaveAttribute('aria-expanded', 'true')
  }
}

async function load(page: Page) {
  await page.goto(ORDERS)
  await expect(page.getByRole('heading', { name: /^Check ·/i })).toBeVisible()
  await expandAll(page)
}

test.describe('supplier proof holding pen', () => {
  test('every placed supplier order is visible somewhere on the page', async ({ page }) => {
    await load(page)
    // The invariant the feature rests on. A pen state that resolved to "render
    // nowhere" would restore the original hole in the exact way nobody notices.
    for (const ref of [CHECK_REF, REVISED_REF, AWAITING_REF, OVERDUE_REF, APPROVED_REF]) {
      await expect(page.getByText(ref, { exact: false }).first()).toBeVisible()
    }
  })

  test('a proof waiting to be checked is work, in its own section', async ({ page }) => {
    await load(page)
    const check = section(page, /^Check ·/i)
    await expect(check.getByText(CHECK_REF)).toBeVisible()
    await expect(check.getByText(REVISED_REF)).toBeVisible()
    // Not the states that belong elsewhere.
    await expect(check.getByText(AWAITING_REF)).toHaveCount(0)
    await expect(check.getByText(OVERDUE_REF)).toHaveCount(0)
    await expect(check.getByText(APPROVED_REF)).toHaveCount(0)
  })

  test('an unapproved proof keeps its order out of the archive', async ({ page }) => {
    await load(page)
    const recent = section(page, /^Recently ordered ·/i)
    // Approved is the pen's terminal state, so it rejoins the archive…
    await expect(recent.getByText(APPROVED_REF)).toBeVisible()
    // …and the four still in the pen must not be filed as done.
    for (const ref of [CHECK_REF, REVISED_REF, AWAITING_REF, OVERDUE_REF]) {
      await expect(recent.getByText(ref)).toHaveCount(0)
    }
  })

  test('a silent supplier escalates to Fix; a normal one does not', async ({ page }) => {
    await load(page)
    const fix = section(page, /^Fix ·/i)
    await expect(fix.getByText(OVERDUE_REF)).toBeVisible()
    // Waiting on a supplier who replied hours ago is NORMAL. If this row ever
    // reaches Fix, the section is crying wolf on every order we place.
    await expect(fix.getByText(AWAITING_REF)).toHaveCount(0)
    await expect(section(page, /^Waiting ·/i).getByText(AWAITING_REF)).toBeVisible()
  })

  test('no order appears in two sections at once', async ({ page }) => {
    await load(page)
    // Object-identity equivalent: each reference resolves to exactly one row.
    // Two would mean a card is claimed by two buckets, which is how a count and
    // its own list drift apart.
    for (const ref of [CHECK_REF, REVISED_REF, AWAITING_REF, OVERDUE_REF, APPROVED_REF]) {
      await expect(page.getByText(ref, { exact: false })).toHaveCount(1)
    }
  })

  test('a re-proof is marked as one, and a first proof is not', async ({ page }) => {
    await load(page)
    // Asserted on the card's own data-reproof marker rather than its copy: the
    // distinction is real behaviour (a corrected proof after sign-off), and it
    // must survive a rewording of the warning that carries it on screen.
    await expect(page.locator(`#order-card-sp-revised`)).toHaveAttribute('data-reproof', 'true')
    await expect(page.locator(`#order-card-sp-check`)).toHaveAttribute('data-reproof', 'false')
  })

  test('clearing a reply opens an editable message addressed to the supplier', async ({ page }) => {
    await load(page)
    const check = section(page, /^Check ·/i)
    await check.getByRole('button', { name: /check & reply|clear it/i }).first().click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    // The body is rendered SERVER-side (preview mode) so per-supplier template
    // overrides resolve in one place — an empty box here means that round trip
    // silently failed and the designer would send nothing.
    const box = dialog.locator('textarea')
    await expect(box).toBeVisible()
    await expect(box).not.toHaveValue('')

    // Exactly one filled primary action; "just record it" stays demoted, because
    // it leaves the supplier with nothing and is the rarer, riskier path.
    const send = dialog.getByRole('button', { name: /send & clear/i })
    await expect(send).toBeEnabled()

    // Emptying the message must disable sending rather than email blank prose.
    await box.fill('')
    await expect(send).toBeDisabled()
  })

  test('the dialog offers a way to read what they sent before replying', async ({ page }) => {
    await load(page)
    await section(page, /^Check ·/i).getByRole('button', { name: /check & reply|clear it/i }).first().click()
    const dialog = page.getByRole('dialog')
    // Approving artwork you cannot see is the failure mode worth guarding: the
    // supplier's proof is an email attachment, so the only route to it is the
    // Help Scout thread.
    await expect(dialog.locator('a[href*="helpscout.net/conversation/"]')).toBeVisible()
  })

  test('a quiet supplier can be cleared straight from Fix', async ({ page }) => {
    await load(page)
    // The realistic recovery: you chase QX, they say "we sent it days ago", and
    // you approve without hunting for the card in another section.
    const fix = section(page, /^Fix ·/i)
    const row = fix.locator('div').filter({ hasText: OVERDUE_REF }).last()
    await row.getByRole('button', { name: /check & reply|clear it/i }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
  })
})
