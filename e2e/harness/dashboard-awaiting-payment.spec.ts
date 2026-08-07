// The dashboard's "Awaiting payment" rail panel (?path=/dashboard), against the
// shared order fixtures: five 'sent' orders, two of which (o3 + its sibling) are
// members of the combined payment g1.
//
// The panel exists because these orders live on the Orders page inside the
// COLLAPSED "Waiting" section, which put the one fact worth watching — has the
// customer opened their pay link? — behind a click. What follows locks in the
// four things that can silently stop being true:
//
//   1. a combined payment is ONE row reading the GROUP's stamps. The members
//      keep the timestamps they had before they were grouped, so a panel that
//      read a member would report an opened combined payment as untouched, and
//      do it once per member. This is the single bug the collapse exists to
//      prevent, and nothing else on screen would reveal it.
//   2. the sort is opened-first-by-recency, then never-opened-by-longest-wait —
//      and is NOT a triage. Nothing floats an expired or held row to the top;
//      that job belongs to the Orders page's Fix section, and a second priority
//      order competing with it is how two lists drift apart.
//   3. every row deep-links to /orders?order=<id>, and that link OPENS the
//      collapsed Waiting section. Without the open, a designer clicking a row
//      lands on a page their order is not visibly on — which is the complaint
//      the whole panel was built to answer, reproduced one click later.
//   4. the summary counts PAYMENTS, not orders, so five orders read as four
//      payments. It sits inches from a tile counting orders, and a bare "4"
//      under a tile reading "5" raises the one question this panel must never
//      raise: what is it not showing me?
//   5. the chase line is fed from the RIGHT ledger — a standalone order's own,
//      a combined payment's group-level one (000388) — and stays silent where
//      no reminder is actually coming, such as a spent cap.
//
// Desktop only — the rail is `hidden lg:block` and the harness project runs a
// desktop viewport.
//
// ⚠ Assert STRUCTURE, never wording. Headings are used to LOCATE the panel
// (there is no other handle for a card in a rail of cards); nothing asserts
// what any row says.

import { test, expect, type Page } from '@playwright/test'

// A row is the only anchor in the panel whose href points back at a single
// order, which makes the href list both the row identity and the sort order.
const ROW_LINK = 'a[href^="/orders?order="]'

function panel(page: Page) {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: /awaiting payment/i }) })
}

/** The order ids the panel is showing, top to bottom. */
async function rowOrderIds(page: Page): Promise<string[]> {
  const hrefs = await panel(page).locator(ROW_LINK).evaluateAll((els) =>
    els.map((el) => el.getAttribute('href') ?? ''),
  )
  return hrefs.map((h) => h.replace('/orders?order=', ''))
}

test.describe('dashboard — awaiting payment panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/verify-harness/index.html?path=/dashboard')
    await expect(panel(page).locator(ROW_LINK).first()).toBeVisible()
  })

  test('collapses a combined payment into one row, and links it to a member', async ({ page }) => {
    const ids = await rowOrderIds(page)
    // Five 'sent' orders in the fixtures; two of them share group g1.
    expect(ids).toHaveLength(4)
    // The group's row targets one of its members, not the group id — the Orders
    // page scrolls to order cards, and a group id matches no card.
    expect(ids).toContain('o3')
    expect(ids.some((id) => id.startsWith('g'))).toBe(false)
  })

  test('a combined payment reports the GROUP as unopened, not a stale member stamp', async ({ page }) => {
    // g1 has never been opened, so its row must sit in the never-opened block —
    // i.e. after the one genuinely opened row, and ordered by how long it has
    // been waiting. If a member's own stamp ever leaks in, this row moves.
    const ids = await rowOrderIds(page)
    expect(ids.indexOf('o3')).toBeGreaterThan(ids.indexOf('o1'))
  })

  test('opened leads; the rest follow by longest wait, and expiry does not jump the queue', async ({ page }) => {
    // o1 opened yesterday; then never-opened by age — o2 (20d, and EXPIRED),
    // g1's row via o3 (6d), o11 (1d). o2 sitting second because it is OLD, not
    // because it expired, is the assertion that keeps this a report and not a
    // second triage.
    expect(await rowOrderIds(page)).toEqual(['o1', 'o2', 'o3', 'o11'])
  })

  test('the opened row is marked differently from the unopened ones', async ({ page }) => {
    // Shape as well as colour: filled for opened, hollow ring for not. Asserted
    // as a contrast between rows rather than a pinned colour, so a palette
    // change cannot fail this while the distinction survives.
    const dots = panel(page).locator(`${ROW_LINK} span[aria-hidden="true"]`)
    const styles = await dots.evaluateAll((els) =>
      els.map((el) => {
        const cs = getComputedStyle(el)
        return { filled: cs.backgroundColor !== 'rgba(0, 0, 0, 0)', ringed: cs.boxShadow !== 'none' }
      }),
    )
    expect(styles[0].filled).toBe(true)
    expect(styles.slice(1).every((s) => !s.filled && s.ringed)).toBe(true)
  })

  // ── The automatic chase ──────────────────────────────────────────────────
  // The panel's third line answers "and when does the next reminder go?". The
  // decision is shared with the Orders card (src/lib/orderReminders.ts), so what
  // matters here is that the panel FEEDS it correctly — per order, from that
  // order's own ledger, with the group short-circuit intact.
  //
  // These assert the stage NUMBERS rather than the sentence around them: the
  // numbers are the decision, the prose is free to change.

  test('the next reminder is read per order from that order’s own ledger', async ({ page }) => {
    // o1 has had one reminder; o11 none. So o1 must be exactly one stage
    // further on — a global or last-write-wins read of the ledger would give
    // them the same number.
    await expect(panel(page).locator('a[href="/orders?order=o1"]')).toContainText(/\b2 of 3\b/)
    await expect(panel(page).locator('a[href="/orders?order=o11"]')).toContainText(/\b1 of 3\b/)
  })

  test('a spent cap promises no further reminder', async ({ page }) => {
    // o2 has all three sent. Offering a fourth would be a promise nothing keeps.
    await expect(panel(page).locator('a[href="/orders?order=o2"]')).not.toContainText(/\d+ of \d+ ·/)
  })

  test('⚠ a combined payment reports its OWN chase, not a member’s', async ({ page }) => {
    // Until 000388 this asserted the opposite — that a combined payment never
    // promises a reminder, because send-order-reminders dropped grouped members
    // outright. That was accurate and it was the bug: nothing chased a combined
    // payment at all, and one lapsed unpaid on live having had zero reminders.
    //
    // g1 has had one group-level reminder, booked against member o3. The row
    // must therefore read stage 2 — and reading it off o3's own order_id (the
    // mistake the two ledgers exist to prevent) gives the same number, so the
    // 'combined' marker is what proves which ledger answered.
    const row = panel(page).locator('a[href="/orders?order=o3"]')
    await expect(row).toContainText(/\b2 of 3\b/)
    await expect(row).toContainText(/combined/i)
  })

  test('a member’s own ledger stays empty while it is grouped', async ({ page }) => {
    // o4 is g1's other member and has no ledger rows of its own. The panel
    // collapses a group to one row, so o4 has no row — the assertion is that
    // the group's single row is the only place its chase is reported, rather
    // than each member claiming the group's reminders separately.
    await expect(panel(page).locator('a[href="/orders?order=o4"]')).toHaveCount(0)
  })

  test('the summary counts payments, so it may legitimately differ from the orders tile', async ({ page }) => {
    // Four rows, and the count in the summary agrees with them. The tile beside
    // it counts five orders; the row that covers two says so itself.
    const rows = await panel(page).locator(ROW_LINK).count()
    await expect(panel(page).getByText(new RegExp(`\\b${rows}\\b`))).toBeVisible()
  })
})

test.describe('dashboard — awaiting payment deep link', () => {
  // The Waiting section is the only disclosure on the Orders page whose
  // accessible name mentions waiting; both states render the same button, so
  // aria-expanded is a real before/after rather than a presence check.
  const waiting = (page: Page) => page.getByRole('button', { expanded: false }).filter({ hasText: /waiting/i })
  const waitingAny = (page: Page) => page.locator('button[aria-expanded]').filter({ hasText: /waiting/i })

  test('arriving without the param leaves Waiting collapsed', async ({ page }) => {
    await page.goto('/verify-harness/index.html?path=/orders')
    await expect(waiting(page)).toHaveCount(1)
    await expect(waitingAny(page).first()).toHaveAttribute('aria-expanded', 'false')
  })

  test('?order=<id> opens Waiting and renders that order card', async ({ page }) => {
    // o1 lives inside the collapsed section. Landing with it still closed would
    // scroll to nothing and show the designer a page their order is not on.
    await page.goto('/verify-harness/index.html?path=/orders&order=o1')
    await expect(waitingAny(page).first()).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('#order-card-o1')).toBeVisible()
  })

  test('an id that is not in the loaded window changes nothing', async ({ page }) => {
    // Paid since, cancelled, or older than the page's 300-row cap. The page must
    // still be its ordinary self rather than erroring or hanging open.
    await page.goto('/verify-harness/index.html?path=/orders&order=does-not-exist')
    await expect(waitingAny(page).first()).toHaveAttribute('aria-expanded', 'false')
  })
})
