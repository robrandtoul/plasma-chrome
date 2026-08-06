// The post-save bundle checkpoint (?path=/bundle-checkpoint).
//
// The real failure this guards: a revision round across a bundle used to end
// every save at the send panel with a big primary Send button — one customer
// email per card, the first arriving while sibling cards were still
// un-revised. The checkpoint's whole job is a HIERARCHY: mid-round there is
// exactly one coloured action and it is navigation (back to the bundle), the
// per-card send surviving only as a quiet text control; once every card
// carries unannounced changes the coloured action becomes the bundle send
// and a neutral way back appears beside it. If the send ever regains primary
// styling mid-round, this feature has silently un-shipped — that's the
// regression these assertions exist to catch.
//
// Structure only, per e2e/CONVENTIONS.md: counts, roles and chroma — never
// copy. The rig builds its model through the real buildBundleCheckpoint, so
// a classification regression (e.g. an announced sibling no longer counting
// as outstanding) also lands here as the wrong button count.

import { test, expect, type Page } from '@playwright/test'

const RIG = '/verify-harness/index.html?path=/bundle-checkpoint'

// The preview-gate spec's definition of "the primary action": the only
// button carrying a hue rather than a neutral. Ghost buttons and text
// controls have near-equal RGB channels; the coral fill does not.
function colouredButtonCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).filter((b) => {
      const m = getComputedStyle(b).backgroundColor.match(/\d+/g)
      if (!m) return false
      const [r, g, bl] = m.map(Number)
      return Math.max(r, g, bl) - Math.min(r, g, bl) > 30
    }).length
  })
}

test.describe('bundle checkpoint', () => {
  test('mid-round: every card listed, one primary action, send demoted to a text control', async ({ page }) => {
    await page.goto(RIG)
    // Four fixture cards: just-saved, revised sibling, un-revised sibling,
    // unbuilt shell — the checklist must show the whole bundle, not just the
    // saved card.
    await expect(page.getByRole('listitem')).toHaveCount(4)
    // Exactly one coloured button (the eye lands on one action), and only
    // two buttons in total — primary navigation plus the demoted per-card
    // send. A second coloured button here is the premature-email regression.
    expect(await colouredButtonCount(page)).toBe(1)
    await expect(page.getByRole('button')).toHaveCount(2)
  })

  test('round complete: a second, neutral action appears beside the primary', async ({ page }) => {
    await page.goto(`${RIG}&state=ready`)
    await expect(page.getByRole('listitem')).toHaveCount(3)
    // Still exactly one coloured action — but the ready state adds the ghost
    // way-back, so the action row is now two buttons plus the text control.
    expect(await colouredButtonCount(page)).toBe(1)
    await expect(page.getByRole('button')).toHaveCount(3)
  })

  test('unsent bundle renders the build-out state', async ({ page }) => {
    await page.goto(`${RIG}&state=unsent`)
    await expect(page.getByRole('listitem')).toHaveCount(3)
    expect(await colouredButtonCount(page)).toBe(1)
    await expect(page.getByRole('button')).toHaveCount(2)
  })

  test('no state renders with an uncaught error', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.text().includes('[harness] uncaught render error')) errors.push(msg.text())
    })
    for (const suffix of ['', '&state=ready', '&state=unsent']) {
      await page.goto(`${RIG}${suffix}`)
      await expect(page.getByRole('listitem').first()).toBeVisible()
    }
    expect(errors).toEqual([])
  })
})
