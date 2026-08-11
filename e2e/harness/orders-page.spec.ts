// The Orders work queue (?path=/orders — also the harness default page).
//
// This page is where paid money sits between "customer paid" and "Stock
// Control is making it", so the failures these specs exist to catch are the
// expensive, silent kind:
//
//   1. the headline figures and the section headings disagreeing — the exact
//      tile-vs-list drift the page has been bitten by before (the old pipeline
//      tiles are gone; what survives is the "N to do · M waiting · £X" summary
//      line, which must agree with the sections it summarises).
//   2. the FIX section (the old "Needs action" sidebar promoted to the top of
//      the page) losing a row kind, or a "Go to it" pointer scrolling to a
//      card that never gets ringed — the designer lands mid-list with no idea
//      which card they were sent to.
//   3. a jump into a COLLAPSED section (Recently ordered) that doesn't open
//      it first — the scroll lands on nothing and the stalled order stays
//      invisible.
//   4. search silently missing a section, or matching everything.
//   5. a To-order card losing its two-state shape: the collapsed triage row
//      must expand into the prep form (date / Dropbox folder / stock colour),
//      because embedding the form in every card once made seven paid orders a
//      whole page of fields.
//   6. a card growing a second always-visible action — the design is ONE
//      visible primary with the rest behind the "⋯" menu.
//   7. combine payments: select mode not offering the eligible orders, the
//      floating confirm bar not gating on two ticks, or the modal opening
//      without the picked orders. (Creation itself is a dropped write in the
//      mock — asserted up to the modal's confirm state only.)
//   8. an unpaid combined group rendering as loose sibling cards instead of
//      ONE tinted container with its members nested inside.
//
// Fixture maths (verify-harness/mock-supabase.ts ORDERS): 5 sent (o2 expired,
// o3+o4 grouped in g1), 8 placeable (o5 invoice-failed, o6 unprepped satin,
// o7 handoff-refused, o13/o14 held, o15/o16 re-approved revisions), o8 being
// revised, 3 fulfilled (o10's workshop note unsent), 2 approved proofs with no
// order (the Send worklist).
//
// ⚠ Assert STRUCTURE, never wording.

import { test, expect, type Page } from '@playwright/test'

// First number in a section heading is its count ("Fix · 3", "Place · 8 · £…").
async function headingCount(page: Page, name: RegExp): Promise<number> {
  const text = await page.getByRole('heading', { name }).innerText()
  const match = text.match(/(\d+)/)
  expect(match, `heading matching ${name} should carry a count`).not.toBeNull()
  return Number(match![1])
}

test.describe('orders work queue', () => {
  test.beforeEach(async ({ page }) => {
    // The harness lives at /verify-harness/index.html — "/" on this port is
    // the real app against a dead backend, a trap that has cost time before.
    await page.goto('/verify-harness/index.html?path=/orders')
    await expect(page.getByRole('heading', { name: 'Orders', exact: true })).toBeVisible()
    // Data has landed once a Place card is on screen.
    await expect(page.locator('#order-card-o5')).toBeVisible()
  })

  test('renders without errors and the summary line agrees with the sections', async ({ page }) => {
    // The summary line and the section headings are computed from the same
    // splits over the same rows — them disagreeing is the drift this page has
    // shipped before (see the toDoCount/waitingCount comments in OrdersPage).
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error' && msg.text().includes('[harness] uncaught render error')) {
        consoleErrors.push(msg.text())
      }
    })
    await page.goto('/verify-harness/index.html?path=/orders')
    await expect(page.locator('#order-card-o5')).toBeVisible()
    expect(consoleErrors).toEqual([])

    // The £ figure appears twice — once in the summary line, once in the
    // Place heading — and both must be the same sum over the same orders.
    const summary = page.locator('p').filter({ has: page.locator('span.font-semibold') }).first()
    const summaryMoney = (await summary.innerText()).match(/£[\d,]+/)?.[0]
    const placeHeading = await page.getByRole('heading', { name: /^place ·/i }).innerText()
    const placeMoney = placeHeading.match(/£[\d,]+/)?.[0]
    expect(summaryMoney).toBeTruthy()
    expect(placeMoney).toBe(summaryMoney)

    // The Place heading's count equals the number of cards actually rendered
    // in the Place section — count/list drift is the regression here.
    const placeCount = await headingCount(page, /^place ·/i)
    const placeSection = page.locator('section').filter({ has: page.getByRole('heading', { name: /^place ·/i }) })
    await expect(placeSection.locator('[id^="order-card-"]')).toHaveCount(placeCount)

    // The waiting figure in the summary equals the Waiting section's count —
    // two different computations that must land on the same number.
    const bolds = summary.locator('span.font-semibold')
    const waitingSummary = Number(await bolds.nth(1).innerText())
    expect(waitingSummary).toBe(await headingCount(page, /^waiting ·/i))
  })

  test('the Fix section carries all three row kinds with their remedies on the row', async ({ page }) => {
    // Fix is the old "Needs action" panel: it renders only when something has
    // gone wrong or gone quiet, and each row carries its own fix. The fixture
    // set produces exactly three rows: an order in Stock Control whose
    // workshop note never went (o10), a paid order whose invoice failed (o5),
    // and an expired unpaid link (o2) as a full card.
    const fixSection = page.locator('section').filter({ has: page.getByRole('heading', { name: /^fix ·/i }) })
    await expect(fixSection).toBeVisible()
    expect(await headingCount(page, /^fix ·/i)).toBe(3)

    // The unsent-message row has its own send button; both pointer kinds have
    // a "Go to it" (the unsent row and the invoice row).
    await expect(fixSection.getByRole('button', { name: /send it now/i })).toHaveCount(1)
    await expect(fixSection.getByRole('button', { name: /go to it/i })).toHaveCount(2)

    // The expired link renders as a full card inside Fix, with the action
    // that clears it (reactivate) right on the card.
    const expiredCard = fixSection.locator('#order-card-o2')
    await expect(expiredCard).toBeVisible()
    await expect(expiredCard.getByRole('button', { name: /reactivate link/i })).toBeVisible()
  })

  test('a Fix pointer row jumps to and rings the stalled card', async ({ page }) => {
    // The whole value of a pointer row is landing the eye on the right card.
    // Rows render unsent-message first, then invoice-failed — so the second
    // "Go to it" belongs to o5, whose card lives further down in Place.
    const o5Panel = page.locator('#order-card-o5 > section')
    await expect(o5Panel).not.toHaveClass(/ring-2/)

    await page.getByRole('button', { name: /go to it/i }).nth(1).click()

    await expect(o5Panel).toHaveClass(/ring-2/)
  })

  test('a jump into the collapsed Recently-ordered list opens it first', async ({ page }) => {
    // Recently ordered starts collapsed; a jump that scrolls without opening
    // it lands on nothing. The first "Go to it" belongs to the fulfilled o10
    // (workshop note unsent), which lives in that collapsed list.
    const recentToggle = page.getByRole('button', { name: /^recently ordered/i })
    await expect(recentToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('#order-card-o10')).not.toBeAttached()

    await page.getByRole('button', { name: /go to it/i }).nth(0).click()

    await expect(recentToggle).toHaveAttribute('aria-expanded', 'true')
    const row = page.locator('#order-card-o10')
    await expect(row).toBeVisible()
    await expect(row).toHaveClass(/ring-2/)
  })

  test('search narrows every section at once and clears back', async ({ page }) => {
    const searchBox = page.locator('input[type=search]')
    const placeBefore = await headingCount(page, /^place ·/i)
    expect(placeBefore).toBeGreaterThan(1)

    // "globex" matches one placeable order (o6) and the two grouped members
    // (o3/o4). The Waiting section auto-opens while searching so matches
    // inside it aren't invisible.
    await searchBox.fill('globex')
    await expect(page.locator('#order-card-o6')).toBeVisible()
    expect(await headingCount(page, /^place ·/i)).toBe(1)
    await expect(page.getByRole('button', { name: /^waiting/i })).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('#order-card-o3')).toBeVisible()
    await expect(page.locator('#order-card-o4')).toBeVisible()
    await expect(page.locator('#order-card-o5')).not.toBeAttached()

    // Gibberish leaves no order cards at all (the Fix section's unsent
    // production row is deliberately unfiltered, but it is not a card).
    await searchBox.fill('zzzquux')
    await expect(page.locator('[id^="order-card-"]')).toHaveCount(0)

    // Clearing restores the full queue.
    await searchBox.fill('')
    await expect(page.locator('#order-card-o5')).toBeVisible()
    expect(await headingCount(page, /^place ·/i)).toBe(placeBefore)
  })

  test('a To-order card expands from triage row to prep form via its primary action', async ({ page }) => {
    // o6 is paid but unprepped (no folder, no date, satin needs a stock
    // colour), so it renders collapsed: no form fields, just the primary that
    // opens them.
    const card = page.locator('#order-card-o6')
    await expect(card.getByRole('button', { name: /prepare order/i })).toBeVisible()
    await expect(card.locator('input[type=date]')).toHaveCount(0)
    await expect(card.locator('input[type=url]')).toHaveCount(0)

    await card.getByRole('button', { name: /prepare order/i }).click()

    // The prep form is now on screen: date required, the Dropbox folder
    // field, and the stock-colour picker (satin).
    await expect(card.locator('input[type=date]')).toHaveCount(1)
    await expect(card.locator('input[type=url]')).toHaveCount(1)
    await expect(card.locator('select')).toHaveCount(1)

    // The primary is now the review-and-place action, disabled because the
    // gates (verified folder, saved date, colour) are still open — and a
    // collapse control appears.
    const review = card.getByRole('button', { name: /^review and/i })
    await expect(review).toBeVisible()
    await expect(review).toBeDisabled()
    await expect(card.getByRole('button', { name: /hide details/i })).toBeVisible()
  })

  test('a collapsed To-order card names its approved files and offers them', async ({ page }) => {
    // The approved artwork used to live ONLY inside the expanded prep form, so
    // "what are this order's files called" and "give me them" — the first move
    // of prep, since the files go into the Dropbox order folder whose link the
    // form then asks for — were behind an expand on every card.
    //
    // o6 (Globex) is the two-recipient fixture: a shared front plus a card
    // each, so the line has to truncate. Two names, then a control for the
    // rest; every name is its own download, and the ZIP takes the lot.
    const card = page.locator('#order-card-o6')
    const artwork = card.getByRole('group', { name: 'Approved artwork' })
    await expect(artwork).toBeVisible()
    await expect(artwork.getByRole('button', { name: /^Download Globex_/ })).toHaveCount(2)
    await expect(artwork.getByRole('button', { name: /^Download all 3 approved artwork/ })).toBeVisible()

    // The truncation is honest: "+1 more" opens the card, where the full list
    // lives. Opening also RETIRES the line — the panel below states the same
    // files, and the two must never both be on screen claiming the set.
    await artwork.getByRole('button', { name: /more$/ }).click()
    await expect(card.locator('input[type=date]')).toHaveCount(1)
    await expect(card.getByRole('group', { name: 'Approved artwork' })).toHaveCount(0)

    // The panel is fed by the page's batch, not its own fetch, so all three
    // files are listed with no loading step in between — the collapsed line
    // and the expanded list cannot name different files.
    await expect(card.getByRole('listitem').filter({ hasText: 'Globex_' })).toHaveCount(3)
  })

  test('a collapsed card shows one visible primary with the rest behind the ⋯ menu', async ({ page }) => {
    // Exactly two card actions on the collapsed o6 card: the primary and the
    // menu trigger. A third always-visible action is the regression.
    //
    // Scoped past the approved-artwork line (the filenames, each of which
    // downloads itself, and its ZIP): those are content — what this order's
    // files are called and how to get them — not another route through the
    // order, which is what the one-primary rule is about.
    const card = page.locator('#order-card-o6')
    await expect(card.locator('button:not([role="group"] button)')).toHaveCount(2)

    await card.getByRole('button', { name: /more actions/i }).click()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    // o6's menu: view proof, copy link, download invoice (it has a Xero
    // invoice), put on hold. No Help Scout item — its proof has no thread.
    await expect(menu.getByRole('menuitem')).toHaveCount(4)

    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
  })

  test('combine payments: select mode, the floating bar gate, and the modal confirm state', async ({ page }) => {
    // No checkboxes outside select mode.
    await expect(page.getByRole('checkbox')).toHaveCount(0)

    await page.getByRole('button', { name: /combine payments/i }).click()

    // Select mode force-opens Waiting and offers a checkbox on every
    // eligible order — the two healthy links (o1, o11) plus the expired o2
    // up in Fix. Grouped members (o3/o4) get none.
    await expect(page.getByRole('button', { name: /^waiting/i })).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('checkbox')).toHaveCount(3)

    // The floating confirm stays disabled until two are ticked.
    const confirm = page.getByRole('button', { name: /combine into one payment/i })
    await expect(confirm).toBeDisabled()
    await page.getByRole('checkbox', { name: /initech/i }).check()
    await expect(confirm).toBeDisabled()
    await page.getByRole('checkbox', { name: /acme/i }).check()
    await expect(confirm).toBeEnabled()

    await confirm.click()

    // The modal lists exactly the two ticked orders, pre-fills the shared
    // destination (both fixtures rate GB), and its create action is live.
    // Creation itself is a dropped write in the mock, so stop at the confirm
    // state.
    const dialog = page.getByRole('dialog', { name: /combine into one payment/i })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('listitem')).toHaveCount(2)
    await expect(dialog.locator('select')).toHaveValue('GB')
    const create = dialog.getByRole('button', { name: /create one payment link/i })
    await expect(create).toBeEnabled()
    await expect(create).toHaveText(/\(2\)/)

    // Cancel backs all the way out: modal gone, select mode reset.
    await dialog.getByRole('button', { name: /^cancel$/i }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('checkbox')).toHaveCount(0)
  })

  test('an unpaid combined group is one container with its member cards nested inside', async ({ page }) => {
    // Waiting starts collapsed — the group lives inside it.
    const waitingToggle = page.getByRole('button', { name: /^waiting/i })
    await expect(waitingToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('#order-card-o3')).not.toBeAttached()
    await waitingToggle.click()

    // The grouping must read as containment: both member cards are
    // DESCENDANTS of one group block, not siblings with matching pills.
    const groupBlock = page.locator('div.rounded-2xl').filter({ has: page.locator('#order-card-o3') })
    await expect(groupBlock).toHaveCount(1)
    await expect(groupBlock.locator('#order-card-o4')).toHaveCount(1)

    // The wrapper owns the group-level actions; each nested member offers
    // only its release (its own pay link is dormant while grouped).
    await expect(groupBlock.getByRole('button', { name: /copy combined link/i })).toBeVisible()
    await expect(groupBlock.getByRole('button', { name: /split back up/i })).toBeVisible()
    await expect(groupBlock.getByRole('button', { name: /release from combined payment/i })).toHaveCount(2)
    const memberButtons = groupBlock.locator('#order-card-o3 button')
    await expect(memberButtons).toHaveCount(2) // release + the ⋯ menu, nothing else

    // An ungrouped healthy link, by contrast, carries its own send/copy pair.
    const standalone = page.locator('#order-card-o1')
    await expect(standalone.getByRole('button', { name: /re-send link/i })).toBeVisible()
    await expect(standalone.getByRole('button', { name: /copy link/i })).toBeVisible()

    // Collapsing hides the lot again.
    await waitingToggle.click()
    await expect(page.locator('#order-card-o3')).not.toBeAttached()
  })
})
