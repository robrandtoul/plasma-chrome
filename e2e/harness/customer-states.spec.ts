// The customer proof page's render states (/p/:id) — the app's single most
// important surface, read by customers with no login and no fallback UI.
//
// Runs against the verify harness with the cp- fixture module
// (verify-harness/fixtures/customer-proof.ts). What these lock in:
//
//   1. one RPC round trip renders the whole page — masthead, recipient card,
//      artwork, spec sheet, QR panel — with no uncaught render error. This
//      page has no error boundary a customer would want to meet: a crash here
//      is a blank screen on the one link we email people.
//   2. the pricing grid respects the designer's curated quantity list rather
//      than dumping every tier, and the quantity lookup answers for the tiers
//      the grid hides. Wrong rows here misquote real money.
//   3. a GBP proof declares VAT-inclusive pricing (a legal requirement for
//      consumer-facing GBP prices, per the business rules).
//   4. the version history strip actually switches versions, and says so.
//   5. the abandoned and not-found states render their quiet screens instead
//      of a crash or a half-rendered proof.
//
// ⚠ Assert STRUCTURE, never wording — names/quantities asserted below are
// fixture data owned by this suite, not app copy.

import { test, expect, type Page } from '@playwright/test'

// Console capture must be attached BEFORE goto so a render error during
// hydration is not missed. The page holds a ~2.8s minimum loading animation,
// so landmark waits rely on the 7s expect timeout.
function captureRenderErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error' && msg.text().includes('[harness] uncaught render error')) {
      errors.push(msg.text())
    }
  })
  return errors
}

test.describe('customer proof page states', () => {
  test('one round trip renders the whole page without a render error', async ({ page }) => {
    const errors = captureRenderErrors(page)
    await page.goto('/verify-harness/index.html?path=/p/cp-basic')

    // Masthead h1 carries the company (fixture data), proving the RPC's
    // proof header landed.
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Kite & Co')

    // The recipient's card renders with both plates (front + back), proving
    // the images edge function's rows were bucketed onto the right version.
    await expect(page.getByText(/Priya's card/)).toBeVisible()
    await expect(page.locator('img[alt*="Priya"]')).toHaveCount(2)

    // The QR row was split OUT of the artwork grid into the dedicated QR
    // panel — exactly one QR image on the page.
    await expect(page.locator('img[alt="QR code"]')).toHaveCount(1)

    // Spec sheet: definition list rows built from the version row.
    await expect(page.locator('dl dd').filter({ hasText: 'Stainless Steel' })).toBeVisible()
    await expect(page.locator('dl dd').filter({ hasText: 'Priya Sharma' })).toBeVisible()

    // The action band offers both decisions (approvals_enabled on).
    await expect(page.getByRole('button', { name: /approve priya/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /request changes/i })).toBeVisible()

    expect(errors).toEqual([])
  })

  test('the pricing grid shows the curated quantities, not every tier', async ({ page }) => {
    await page.goto('/verify-harness/index.html?path=/p/cp-basic')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Kite & Co')

    // The fixture prices five tiers but curates display_quantities to three.
    // A regression that ignores the curation (or drops the intersection
    // logic) changes this count.
    const table = page.locator('table')
    await expect(table).toHaveCount(1)
    const rows = table.locator('tbody tr')
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0).locator('td').first()).toHaveText('100')
    await expect(rows.nth(1).locator('td').first()).toHaveText('250')
    await expect(rows.nth(2).locator('td').first()).toHaveText('500')
    // The uncurated tiers stay hidden from the grid.
    await expect(table).not.toContainText('2,000')

    // Prices render in the version's currency.
    await expect(rows.nth(0)).toContainText('£')
  })

  test('the quantity lookup answers for tiers the grid hides', async ({ page }) => {
    await page.goto('/verify-harness/index.html?path=/p/cp-basic')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Kite & Co')

    // The lookup input is the page's only main-surface textbox.
    const input = page.getByRole('textbox')
    await expect(input).toHaveCount(1)

    // Exact hidden tier → one result row, announced via the status caption.
    await input.fill('1000')
    await expect(page.getByRole('status')).toBeVisible()
    const resultTable = page.locator('table').nth(1)
    await expect(resultTable).toBeVisible()
    await expect(resultTable.locator('tbody tr')).toHaveCount(1)
    await expect(resultTable).toContainText('1,000')

    // Between two tiers → both brackets shown.
    await input.fill('750')
    await expect(resultTable.locator('tbody tr')).toHaveCount(2)
    await expect(resultTable).toContainText('500')
    await expect(resultTable).toContainText('1,000')

    // Cleared input → the result panel folds away entirely.
    await input.fill('')
    await expect(page.locator('table')).toHaveCount(1)
  })

  test('a GBP proof declares VAT-inclusive pricing', async ({ page }) => {
    // "VAT" is the one token asserted by word: GBP prices are VAT-inclusive
    // by business rule and the page must say so somewhere in the pricing
    // panel. The phrasing around it is free to change.
    await page.goto('/verify-harness/index.html?path=/p/cp-basic')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Kite & Co')
    await expect(page.getByText(/VAT/i).first()).toBeVisible()
    await expect(page.getByText(/GBP/).first()).toBeVisible()
  })

  test('the version strip switches versions and flags the older one', async ({ page }) => {
    await page.goto('/verify-harness/index.html?path=/p/cp-earlier')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Noor Haddad')

    // Two version cards; the current one is pressed on load. Anchored to the
    // start of the label — the plate images' own labels also mention
    // "proof version N" and must not match.
    const v1 = page.getByRole('button', { name: /^view(ing)? version 1\b/i })
    const v2 = page.getByRole('button', { name: /^view(ing)? version 2\b/i })
    await expect(v1).toBeVisible()
    await expect(v2).toHaveAttribute('aria-pressed', 'true')
    await expect(v1).toHaveAttribute('aria-pressed', 'false')

    // On the current version the strip's status band offers no action; on
    // an older one it grows the way back. A single status element exists at
    // rest, so the before/after on its button count is unambiguous.
    const banner = page.getByRole('status')
    await expect(banner).toHaveCount(1)
    await expect(banner.getByRole('button')).toHaveCount(0)

    await v1.click()
    await expect(v1).toHaveAttribute('aria-pressed', 'true')
    await expect(v2).toHaveAttribute('aria-pressed', 'false')
    await expect(banner.getByRole('button')).toHaveCount(1)

    // The band's return route lands back on the current version.
    await banner.getByRole('button').click()
    await expect(v2).toHaveAttribute('aria-pressed', 'true')
    await expect(banner.getByRole('button')).toHaveCount(0)
  })

  test('an abandoned proof renders the quiet closed screen', async ({ page }) => {
    const errors = captureRenderErrors(page)
    await page.goto('/verify-harness/index.html?path=/p/cp-abandoned')

    // The customer's identity still heads the page (fixture data), but no
    // decision surface survives — no approve, no request changes.
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Aster & Co')
    await expect(page.getByRole('button', { name: /approve/i })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /request changes/i })).toHaveCount(0)

    // The get-in-touch form is the screen's one action: name/email/message
    // fields (the honeypot is aria-hidden, so it must not count) + submit.
    await expect(page.getByRole('textbox')).toHaveCount(3)
    const send = page.getByRole('button', { name: /send/i })
    await expect(send).toBeVisible()

    // Submitting reaches the sent confirmation (proof-contact-submit is
    // stubbed ok). The mock is stateless — assert the optimistic state only.
    await page.getByRole('textbox').nth(1).fill('wes@aster.example')
    await page.getByRole('textbox').nth(2).fill('Could we pick this back up?')
    await send.click()
    await expect(page.getByRole('status')).toBeVisible()
    await expect(page.getByRole('textbox')).toHaveCount(0)

    expect(errors).toEqual([])
  })

  test('an unknown id renders the not-found screen, calmly', async ({ page }) => {
    const errors = captureRenderErrors(page)
    await page.goto('/verify-harness/index.html?path=/p/cp-missing')

    // The RPC returns SQL NULL for an unknown proof; the page must land on
    // its 404 screen rather than crash or spin forever.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByText('404')).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /approve/i })).toHaveCount(0)

    expect(errors).toEqual([])
  })
})
