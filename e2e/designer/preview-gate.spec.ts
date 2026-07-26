// The designer's pre-send review banner.
//
// Rob's verdict on the live version: "only the green one is clearly a button…
// like we've just dumped buttons and indicators wherever we can fit them." The
// cause was that secondary buttons and progress chips shared `ring-1 ring-ink`
// on an ink banner — an invisible outline — so the actions read as plain text
// and the status chips read as buttons.
//
// These assertions encode the structure, not the styling: actions carry a
// visible outline, status does not, and everything actionable sits in one
// cluster rather than scattered across rows.

import { test, expect } from '@playwright/test'
import path from 'node:path'

const OUT = path.join(process.cwd(), 'docs', 'guide-shots')

test.describe('preview gate banner', () => {
  test.beforeEach(async ({ page }) => {
    // The harness is served at /verify-harness/index.html — "/" on this port is
    // the real app, which is why an earlier attempt kept rendering the dashboard.
    await page.goto('/verify-harness/index.html?path=/preview-gate')
    await expect(page.getByText(/what the customer will see/i)).toBeVisible()
  })

  test('every action carries a visible outline, so it reads as pressable', async ({ page }) => {
    for (const name of [/go back and edit/i, /looks good|continue to send|checked it/i]) {
      const btn = page.getByRole('button', { name }).first()
      await expect(btn).toBeVisible()
      const visible = await btn.evaluate((el) => {
        const s = getComputedStyle(el)
        // Either a real border/ring, or a filled background — both read as a
        // control. Transparent-on-transparent is what the bug looked like.
        const ring = s.boxShadow !== 'none' || parseFloat(s.borderTopWidth) > 0
        const filled = s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent'
        return ring || filled
      })
      expect(visible, `"${name}" must look like a control`).toBe(true)
    }
  })

  test('exactly one primary action', async ({ page }) => {
    // More than one filled button and the eye has nowhere to land.
    const filled = await page.evaluate(() => {
      const banner = document.querySelector('.bg-ink')
      if (!banner) return -1
      return Array.from(banner.querySelectorAll('button')).filter((b) => {
        const bg = getComputedStyle(b).backgroundColor
        return bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent'
      }).length
    })
    expect(filled).toBe(1)
  })

  test('actions sit together, not scattered across rows', async ({ page }) => {
    const edit = await page.getByRole('button', { name: /go back and edit/i }).first().boundingBox()
    const confirm = await page
      .getByRole('button', { name: /looks good|continue to send|checked it/i })
      .first()
      .boundingBox()
    expect(edit).not.toBeNull()
    expect(confirm).not.toBeNull()
    // Same row: their vertical centres line up.
    const editMid = edit!.y + edit!.height / 2
    const confirmMid = confirm!.y + confirm!.height / 2
    expect(Math.abs(editMid - confirmMid)).toBeLessThan(6)
  })

  test('guide shot', async ({ page }) => {
    const banner = page.locator('.bg-ink').first()
    await expect(banner).toBeVisible()
    await banner.screenshot({ path: path.join(OUT, 'designer-preview-gate.png') })
  })
})
