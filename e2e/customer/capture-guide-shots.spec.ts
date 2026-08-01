// Captures the screenshots used in the designer guide PDF.
//
// Deliberately a test rather than a manual grab: the guide then shows the real
// UI at a known state, and re-running it after a change reveals whether the
// guide has gone stale. Output lands in docs/guide-shots/ (gitignored).
//
// Not part of the normal suite — run explicitly:
//   npx playwright test --project=customer -g "guide shot"

import { test, expect } from '@playwright/test'
import path from 'node:path'

const PROOF_ID = 'b7d0796e-c7a5-44d1-860c-e39f92730521'
const OUT = path.join(process.cwd(), 'docs', 'guide-shots')

test.describe('guide shot', () => {
  test('customer surfaces', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    // ?preview=1 skips record_proof_view — without it every local run records a
    // real customer view on the shared fixture, feeding the needs-attention
    // rules and waking snoozes. See src/lib/customerProofUrl.ts.
    await page.goto(`/p/${PROOF_ID}?preview=1`)

    const strip = page.getByRole('button', { name: /notes? from/i })
    await expect(strip).toBeVisible()

    // 1. The notes as the customer meets them: open, above the decision, with
    //    the card above them unmarked.
    const card = page.locator('section, div').filter({ has: strip }).last()
    await strip.scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    await page.screenshot({
      path: path.join(OUT, 'customer-notes.png'),
      clip: await (async () => {
        const box = await card.boundingBox()
        const s = await strip.boundingBox()
        if (!s) throw new Error('no strip')
        // Frame from a little above the strip to a little below it, so the shot
        // shows the notes together with the buttons underneath.
        return {
          x: Math.max(0, (box?.x ?? s.x) - 8),
          y: Math.max(0, s.y - 220),
          width: Math.min(1280, (box?.width ?? s.width) + 16),
          height: 560,
        }
      })(),
    })

    // 2. The zoom view, where a numbered marker is allowed on the artwork.
    await page.getByRole('button', { name: /view on the card/i }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await page.waitForTimeout(600)
    await page.screenshot({ path: path.join(OUT, 'customer-zoom.png') })
  })

  test('customer change request panel', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    // ?preview=1 skips record_proof_view — without it every local run records a
    // real customer view on the shared fixture, feeding the needs-attention
    // rules and waking snoozes. See src/lib/customerProofUrl.ts.
    await page.goto(`/p/${PROOF_ID}?preview=1`)
    await expect(page.getByRole('button', { name: /notes? from/i })).toBeVisible()

    const request = page.getByRole('button', { name: /^Request changes/i }).first()
    if (await request.count()) {
      await request.click()
      await page.waitForTimeout(700)
      await page.screenshot({ path: path.join(OUT, 'customer-request-changes.png') })
    }
  })
})
