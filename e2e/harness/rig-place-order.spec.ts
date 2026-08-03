// The place-order review screen (?path=/orders/o1/place — OrderReviewPage
// against the fixture place-order preview: in-house route, a Stock Control
// hand-off problem + warning, and a flagged artwork-check report).
//
// This page is the last look before real money's worth of cards is produced:
// preview and confirm both come from place-order, so what's shown is what
// goes out. The real failures these specs exist to catch:
//
//   1. the summary silently not being the server's preview — a reviewer
//      confirming against stale or empty facts (wrong customer, wrong
//      quantity, wrong date) is exactly the class of mistake the page exists
//      to prevent.
//   2. the Stock Control hand-off checks becoming BLOCKING. They are shadow
//      mode by design: surfaced so mapping gaps get fixed, but never gating
//      Confirm — a regression that disables the button on a validation
//      problem strands a paid order behind an advisory.
//   3. the artwork-check card losing its field-by-field table or its flag
//      detail — the verdict headline alone doesn't tell a reviewer WHAT to
//      look at, and the side-by-side comparison is second only to the verdict
//      (Rob, 2026-07-24).
//   4. the per-flag Investigate button not landing its timeline in the
//      report, or staying clickable after it has answered itself — the walk
//      is cached into the on-screen report without a refetch, and a dead or
//      duplicate button hides that.
//   5. the running state losing its spinner — the real check takes ~30–50s,
//      and a blank card reads as "no check", which on a required-check order
//      invites a support ticket.
//
// The mock resolves the check instantly, so the running state is reached via
// the harness's own sessionStorage 'artworkHang' switch (see mock-supabase),
// which hangs the report invoke and leaves the spinner up.
//
// ⚠ Assert STRUCTURE, never wording — the values asserted below are fixture
// DATA (names, quantities, dates, messages from the invoke fixture), which
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

test.describe('place-order review (o1, in-house)', () => {
  test.beforeEach(async ({ page }) => {
    // The harness lives at /verify-harness/index.html — "/" on this port is
    // the real app against a dead backend, a trap that has cost time before.
    await page.goto('/verify-harness/index.html?path=/orders/o1/place')
    await expect(page.getByRole('heading', { name: /place order/i })).toBeVisible()
    // The preview has landed once the fixture customer is on screen.
    await expect(page.getByText(/acme ltd/i).first()).toBeVisible()
  })

  test('renders clean and the summary is the invoke fixture, fact for fact', async ({ page }) => {
    const errors = collectHarnessErrors(page)
    const main = page.locator('main')

    // The order-at-a-glance panel: material, quantity, date required — all
    // straight off the preview payload.
    await expect(main.getByText(/stainless steel/i).first()).toBeVisible()
    await expect(main.getByText(/500 cards/)).toBeVisible()
    // exact: the same date also sits inside the message textarea's value.
    await expect(main.getByText('30/07/2026', { exact: true })).toBeVisible()

    // The artwork row links to the fixture Dropbox folder.
    await expect(main.getByRole('link', { name: /dropbox/i })).toHaveAttribute(
      'href',
      'https://www.dropbox.com/example',
    )

    // The hand-off is shown verbatim: the subject line and the message box
    // seeded from the preview's note_lines — what's shown is what goes out.
    await expect(main.getByText(/403999/)).toBeVisible()
    await expect(main.locator('textarea').first()).toHaveValue(/Qty: 500/)

    // In-house route: no supplier picker anywhere (the supplier route renders
    // a select; this one posts a note), and both hand-off files are named in
    // the attach plan.
    await expect(main.getByRole('combobox')).toHaveCount(0)
    await expect(main.getByText('Approved_Front.pdf')).toBeVisible()
    await expect(main.getByText('Approved_Back.pdf')).toBeVisible()

    expect(errors).toEqual([])
  })

  test('the hand-off validation lists the problem and the warning without blocking Confirm', async ({ page }) => {
    // Both fixture findings render, each as its own list item.
    await expect(
      page.getByRole('listitem').filter({ hasText: /no Stock Control mapping/ }),
    ).toHaveCount(1)
    await expect(
      page.getByRole('listitem').filter({ hasText: /don.t add up/ }),
    ).toHaveCount(1)

    // Non-blocking by design: shadow-mode checks surface gaps, they never
    // gate. Confirm must stay live with a problem on screen.
    await expect(page.getByRole('button', { name: /confirm/i })).toBeEnabled()
    await expect(page.getByRole('button', { name: /cancel/i })).toBeEnabled()
  })

  test('the artwork-check card renders the flagged report: table, flag detail, correction', async ({ page }) => {
    // Field-by-field: the fixture card label heads a three-row comparison
    // table (name / email / job_title), printed vs supplied side by side.
    await expect(page.getByText('Derrick Smith — front/back').first()).toBeVisible()
    await expect(page.getByText('derick@plak8.com').first()).toBeVisible() // printed (wrong)
    await expect(page.getByText('derrick@plak8.com (request form)').first()).toBeVisible() // supplied
    await expect(page.getByText('job title')).toBeVisible() // underscores humanised

    // The flag's own detail block quotes both values again, and the unresolved
    // customer correction renders as its own block with the fixture quote.
    await expect(page.getByText(/12 Jul/).first()).toBeVisible()

    // The reviewer's controls on a flag: investigate, or hold-and-ask. And the
    // card-level Re-run stays available.
    await expect(page.getByRole('button', { name: /investigate the history/i })).toHaveCount(1)
    await expect(page.getByRole('button', { name: /hold this/i })).toHaveCount(1)
    await expect(page.getByRole('button', { name: /re-run/i })).toBeVisible()
  })

  test('Investigate lands the history walk in the report and retires its own button', async ({ page }) => {
    // No timeline before the walk.
    await expect(page.locator('details')).toHaveCount(0)

    await page.getByRole('button', { name: /investigate the history/i }).click()

    // The fixture investigation merges into the on-screen report without a
    // refetch: a collapsible timeline appears inside the flag block…
    const timeline = page.locator('details')
    await expect(timeline).toHaveCount(1)
    await timeline.locator('summary').click()
    await expect(timeline.locator('li')).toHaveCount(4)
    await expect(timeline.locator('li').first()).toContainText('2026-07-08')

    // …and the button is gone — the question it answers is now answered on
    // screen. Holding stays offered either way.
    await expect(page.getByRole('button', { name: /investigate the history/i })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /hold this/i })).toHaveCount(1)
  })

  test('while the check is running the card shows a spinner, not a report', async ({ page }) => {
    // 'artworkHang' makes the mock's report invoke hang (harness-only switch,
    // documented in mock-supabase), so the running state actually holds still
    // long enough to look at — the normal mock resolves in a microtask.
    await page.evaluate(() => sessionStorage.setItem('artworkHang', '1'))
    await page.reload()
    await expect(page.getByText(/acme ltd/i).first()).toBeVisible()

    // The card announces the in-flight check with a live spinner…
    await expect(page.getByRole('status')).toBeVisible()
    // …and none of the report has rendered yet.
    await expect(page.getByText('derick@plak8.com')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /investigate the history/i })).toHaveCount(0)
  })
})
