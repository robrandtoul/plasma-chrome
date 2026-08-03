// VAT claims on the customer proof page are gated by currency.
//
// The business rule (CLAUDE.md, seed data, the pricing-card footer, the Xero
// invoicing path): GBP prices are VAT-INCLUSIVE; EUR and USD prices are
// VAT-FREE. The August 2026 suite build found the pricing panel's eyebrow
// falling through to "Inclusive of VAT" for every currency — so a EUR/USD
// customer was shown a VAT claim that contradicts how they are actually
// billed. These specs exist so that claim can never silently come back.
//
// ⚠ Deliberate exception to the assert-structure-never-wording rule: the word
// "VAT" is itself the invariant here — it is a load-bearing statement about
// billing, not presentation copy. The assertion is the term's presence or
// absence by currency, never its surrounding phrasing.

import { test, expect } from '@playwright/test'

test.describe('VAT claims follow the currency', () => {
  test('a GBP proof states its prices include VAT', async ({ page }) => {
    await page.goto('/verify-harness/index.html?path=/p/cp-basic')
    // The pricing panel is the section titled by the "Pricing" heading; the
    // claim may sit in its eyebrow or the per-quantity suffix — either
    // satisfies the rule, so assert at the page level.
    await expect(page.getByRole('heading', { name: /pricing/i }).first()).toBeVisible()
    // \b guards matter: the footer's "INNOVATIVE" contains the letters VAT,
    // so a bare substring match would pass without any real claim on the page.
    await expect(page.getByText(/\bVAT\b/).first()).toBeVisible()
  })

  test('a EUR proof makes no VAT claim anywhere', async ({ page }) => {
    await page.goto('/verify-harness/index.html?path=/p/cp-eur')
    // Same page, same panel, different currency: the pricing table must
    // render (prices are still shown) with the VAT wording absent from the
    // whole document — the eyebrow, the suffix, and anything added later.
    // The tier cell is matched on the figure alone: EUR renders "179 €"
    // (symbol after, non-breaking space), so a symbol-anchored locator would
    // couple this spec to number formatting.
    await expect(page.getByRole('heading', { name: /pricing/i }).first()).toBeVisible()
    await expect(page.getByRole('cell', { name: /179/ }).first()).toBeVisible()
    await expect(page.getByText(/\bVAT\b/)).toHaveCount(0)
  })
})
