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
    // More than one COLOURED button and the eye has nowhere to land.
    //
    // "Has a background" was the first definition here and it stopped meaning
    // anything the moment the banner went light — every button sits on a tinted
    // ground now. What actually marks the primary action is that it is the only
    // one carrying a hue rather than a neutral.
    const coloured = await page.evaluate(() => {
      const banner = document.querySelector('[data-testid="preview-gate-banner"]')
      if (!banner) return -1
      return Array.from(banner.querySelectorAll('button')).filter((b) => {
        const m = getComputedStyle(b).backgroundColor.match(/\d+/g)
        if (!m) return false
        const [r, g, bl] = m.map(Number)
        // Chroma: a neutral (white, cream, grey) has near-equal channels.
        return Math.max(r, g, bl) - Math.min(r, g, bl) > 30
      }).length
    })
    expect(coloured).toBe(1)
  })

  test('the pre-send actions share a row; the way back sits apart', async ({ page }) => {
    // Grouped by what they are, not by being actions. Add a note, run the proof
    // check and send are all things you might DO before sending, so they sit
    // together. "Go back and edit" is the escape hatch and drops a row — Rob's
    // call, and it stops the way out competing with the way on.
    const check = await page
      .getByRole('button', { name: /run proof check|proof check ·|checking/i })
      .first()
      .boundingBox()
    const confirm = await page
      .getByRole('button', { name: /looks good|continue to send|checked it/i })
      .first()
      .boundingBox()
    const edit = await page.getByRole('button', { name: /go back and edit/i }).first().boundingBox()
    expect(check).not.toBeNull()
    expect(confirm).not.toBeNull()
    expect(edit).not.toBeNull()

    const mid = (b: { y: number; height: number }) => b.y + b.height / 2
    expect(Math.abs(mid(check!) - mid(confirm!))).toBeLessThan(6)
    expect(mid(edit!)).toBeGreaterThan(mid(confirm!) + 10)
  })

  test('guide shot', async ({ page }) => {
    const banner = page.getByTestId('preview-gate-banner')
    await expect(banner).toBeVisible()
    await banner.screenshot({ path: path.join(OUT, 'designer-preview-gate.png') })
  })
})
