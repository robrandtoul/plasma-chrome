// The Latest-activity card's SOURCES — what the feed is built from, as opposed
// to how a live row folds into it (dashboard-activity-live.spec.ts).
//
// The card is a dozen sources merged on the client. Most are not stored events
// at all but timestamps bridged into the feed shape — a payment, a question
// asked at the checkout, a bundle being opened — and each one arrives as a new
// `event_type` that has to be mapped to an icon, a tint and a verb.
//
// What these lock in, and the real failure each exists to catch:
//
//   1. every event type the fixtures can produce actually RENDERS. The panel
//      looks its visuals up by event type with no fallback, so a type that
//      reaches the card unmapped reads `undefined.icon` and takes the whole
//      dashboard down with it — not just its own row. That is the single most
//      likely way this feature breaks as sources are added, and it cannot
//      happen quietly: an uncaught render error blanks the page.
//   2. a row goes where it says it goes. Almost every row opens its project,
//      but a bundle-opened row must open the BUNDLE — the thing that was
//      actually opened — and rows differ only in destination, so a bare "did
//      we navigate" assertion would pass with every link pointing at the wrong
//      place.
//   3. the feed still holds its cap. Ten queries feed this card now; the merge
//      sorts and trims them to one length, and a source added outside that
//      trim would grow the card past what a rebuild would produce.
//
// Fixture rows behind these (verify-harness/mock-supabase.ts): three paid
// orders, a combined payment group (g2) whose pay link was opened, an order
// with a checkout question (o3) and one asking for a fresh link (o4), a
// customer reorder request on p-x1, and an opened bundle (set-a).
//
// ⚠ Assert STRUCTURE and FIXTURE DATA, never UI wording.

import { test, expect, type Page } from '@playwright/test'

// Feed rows are the only li[role="button"] on this page — project rows are
// div[role="button"] — so this needs no dependence on the panel's heading.
const FEED_ROW = 'li[role="button"]'

// Matches ACTIVITY_FEED_CAP. The fixtures produce comfortably more than this,
// which is what makes the trim assertion meaningful rather than incidental.
const FEED_CAP = 20

async function openDashboard(page: Page) {
  // The harness lives at /verify-harness/index.html — "/" on this port is the
  // real app against a dead backend, a trap that has cost time before.
  await page.goto('/verify-harness/index.html?path=/dashboard')
  await expect(page.locator(FEED_ROW).first()).toBeVisible()
}

test.describe('latest activity — sources', () => {
  test('every fixture event type renders without taking the page down', async ({ page }) => {
    // Attached BEFORE navigation so a crash during first paint is caught. An
    // unmapped event type throws inside the feed's map, which React unwinds all
    // the way up — so this listener, not a per-row assertion, is what catches
    // the failure this test exists for.
    const errors: string[] = []
    page.on('console', (m) => {
      if (m.text().includes('[harness] uncaught render error')) errors.push(m.text())
    })

    await openDashboard(page)

    // A full card. If any row's visual lookup had failed there would be no
    // card at all, so this count is the proof that all of them resolved.
    await expect(page.locator(FEED_ROW)).toHaveCount(FEED_CAP)
    expect(errors).toEqual([])
  })

  test('the newest rows are the order and checkout ones the fixtures pin most recently', async ({ page }) => {
    await openDashboard(page)

    // Named from FIXTURE DATA, not copy: Wonka Industries exists only as the
    // combined-payment group, and its pay-link open is stamped 3h ago. Reaching
    // the card at all proves the order_groups source is read — the open is
    // stamped on the GROUP, never on a member, so an implementation that reads
    // only the orders table shows a combined payment as nothing whatsoever.
    //
    // Pinned to the pay-link-open row rather than to Wonka's row count, which
    // is no longer 1: the same group now also carries a confirmation stamp, and
    // counting the customer's rows would make this test fail every time the
    // group grows a source rather than when the one it is about breaks.
    await expect(page.locator(`${FEED_ROW}[data-event-type="pay_link_opened"]`)
      .filter({ hasText: 'Wonka Industries' })).toHaveCount(1)

    // Leccy.Tech's reorder request (p-x1) is the only row that comes from the
    // projects array rather than a query of its own.
    await expect(page.locator(FEED_ROW).filter({ hasText: 'Leccy.Tech' }).first()).toBeVisible()
  })

  test('a bundle row opens the bundle; an ordinary row opens its project', async ({ page }) => {
    await openDashboard(page)

    // set-a is the opened bundle, and p-b1/2/3 are its cards. The row must
    // reach the workspace — landing on a card would be a plausible-looking
    // wrong answer, since the row is named after the same customer.
    const bundleRow = page.locator(FEED_ROW).filter({ hasText: 'Atlus Consulting Engineers' }).last()
    await bundleRow.click()
    await expect(page.locator('[data-nav-target]')).toHaveAttribute('data-nav-path', '/bundles/set-a')
  })

  test('rows without an override still open their own project', async ({ page }) => {
    await openDashboard(page)

    // The default destination, asserted alongside the override so a change that
    // sent every row to the same place can't pass by satisfying only the
    // bundle case above.
    await page.locator(FEED_ROW).first().click()
    await expect(page.locator('[data-nav-target]')).toHaveAttribute('data-nav-path', /^\/proofs\//)
  })
})

// ── The outbound family ───────────────────────────────────────────────────────
//
// Everything we send reaches the customer as a Help Scout agent reply and stamps
// one column, so the card called all of it "was sent a reply": a hand-typed note,
// an automated chase and an order confirmation were one indistinguishable row.
// Each type below reads the record that kind of message left on its own way out.
//
// These assert on data-event-type rather than copy, deliberately. The outbound
// rows differ from one another in WORDING alone — every one is a muted row about
// a message we sent — so matching on text would be the one thing this suite's
// conventions forbid, and matching on the icon or tint could not tell a
// follow-up reminder from a payment reminder at all.
test.describe('latest activity — naming what we sent', () => {
  const typed = (page: Page, type: string) => page.locator(`${FEED_ROW}[data-event-type="${type}"]`)

  test('a designer message names its sender instead of reading as "a reply"', async ({ page }) => {
    await openDashboard(page)

    // ver-a1: Donna Lambe sent v2 of p-a1 six hours ago. The row exists at all
    // only because proof_versions.last_reply_sent_by is read — the proof detail
    // timeline has named senders from that column for months while this card
    // threw it away.
    await expect(typed(page, 'designer_message').filter({ hasText: 'Donna Lambe' })).toHaveCount(1)
  })

  // The rule that keeps the automation honest. send-nudges stamps
  // last_reply_sent_at exactly as a human sender does but leaves
  // last_reply_sent_by NULL on purpose, so the NULL is what marks a message no
  // person wrote. ver-x1 is that shape; crediting it to a designer would have
  // the card report human contact that never happened.
  test('an automated chase is never dressed up as a designer message', async ({ page }) => {
    await openDashboard(page)

    await expect(typed(page, 'followup_reminder')).toHaveCount(1)
    // Nobody is credited: the actor is the customer, so the row carries no
    // designer name at all. Christopher is the sender of the OTHER Leccy.Tech
    // row (ver-x1b), which is what makes this a real distinction rather than an
    // absence of names on the page.
    await expect(typed(page, 'followup_reminder').filter({ hasText: 'Christopher' })).toHaveCount(0)
  })

  // Three sends to ONE project in the fixtures. send-nudges runs as a batch
  // twice a day and put 93 reminders on live in 7 days; at a row each they would
  // take the top of this 20-row card every morning and push out the views,
  // approvals and payments it exists to show.
  test('a project chased three times still spends one row on it', async ({ page }) => {
    await openDashboard(page)
    await expect(typed(page, 'followup_reminder')).toHaveCount(1)
  })

  test('the order acknowledgement says what it is', async ({ page }) => {
    await openDashboard(page)

    // Stamped on the GROUP for a combined payment (g2) — one payment, one
    // confirmation. Reading the orders table alone shows it nowhere, since no
    // member carries the stamp.
    await expect(typed(page, 'order_confirmation_sent').filter({ hasText: 'Wonka Industries' })).toHaveCount(1)
  })

  // ONE MESSAGE, ONE ROW. p-x1 carries both records of a single email: the
  // version stamp the edge function wrote (ver-x1b) and the proof stamp Help
  // Scout's webhook wrote, pinned to the same instant. Before supersedeOutbound
  // both reached the card, so the same message printed twice — once named and
  // once anonymously.
  test('one message does not print twice under two names', async ({ page }) => {
    await openDashboard(page)

    const leccyRows = page.locator(FEED_ROW).filter({ hasText: 'Leccy.Tech' })
    const named = leccyRows.filter({ hasText: 'Christopher Jackson-Whitmore' })
    await expect(named).toHaveCount(1)
    // The generic row describing that same send is gone — asserted for THIS
    // project rather than globally, because staff_reply is still the right
    // answer elsewhere (a reply typed straight into Help Scout leaves no record
    // of what it was, and the card should keep saying so).
    await expect(leccyRows.filter({ has: page.locator('[data-event-type="staff_reply"]') })).toHaveCount(0)
    await expect(typed(page, 'staff_reply').first()).toBeVisible()
  })
})
