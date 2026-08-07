// The post-save preview gate's "does this set hang together?" notice.
//
// The gate is the last screen before the reply that sends the proof, so
// it is the last chance to notice that a set is half-built. The check
// reads the saved artwork rows and says what it found (rules and the
// live proofs behind them: src/lib/setConsistency.ts).
//
// What these catch:
//   * a notice that stops rendering — the whole point is that a
//     designer sees it without going looking, and silence here is
//     indistinguishable from "nothing wrong";
//   * a notice that BLOCKS. It must not. None of these findings is
//     certainly wrong (a set really can have one person on a different
//     card), the gate is explicitly "a check, not a punishment", and a
//     false blocker between a finished proof and the customer is worse
//     than the defect it guards. The confirm button's own state is
//     owned by the review checklist and nothing else.
//
// ⚠ Assert STRUCTURE, never wording — the copy here is expected to be
// tuned as designers use it.

import { test, expect } from '@playwright/test'

const GATE = '/verify-harness/index.html?path=/preview-gate'

test.describe('preview gate — set consistency', () => {
  test('an unlabelled side is raised before sending, and never blocks it', async ({ page }) => {
    await page.goto(GATE)

    // The fixture reproduces The Sourdough Company: shared front, a back
    // each, one recipient's artwork carrying no side.
    const notice = page.getByTestId('set-consistency-notice')
    await expect(notice).toBeVisible()
    await expect(notice.locator('li')).toHaveCount(1)

    // It names the person, so the designer knows where to look without
    // opening the version again.
    await expect(notice).toContainText('James Gunns')

    // Advisory: the confirm button is not disabled BY this. (Whether it
    // is enabled at all is the review checklist's business, so assert
    // only that the notice hasn't taken it over.)
    const confirm = page.getByRole('button', { name: /looks good/i })
    await expect(confirm).toBeVisible()
    await expect(confirm).toBeEnabled()
  })

  test('sits inside the gate banner, above the customer preview', async ({ page }) => {
    await page.goto(GATE)
    const banner = page.getByTestId('preview-gate-banner')
    await expect(banner.getByTestId('set-consistency-notice')).toBeVisible()
  })
})
