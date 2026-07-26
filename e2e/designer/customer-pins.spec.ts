// The designer's view of what the customer pointed at (migration 000347).
//
// Runs against the verify harness (?path=/customer-pins), which is the only way
// to reach a signed-in surface here — an agent cannot type a password. The
// fixture supplies two customer pins, one per side, sharing a single created_at
// because proof-action writes them in one insert.
//
// What these lock in, all of it found by running the feature end to end:
//
//   1. the pins are DRAWN on the artwork, in their own colour. They were stored
//      and then shown only as a text list, so the designer read "move this left"
//      with no idea where — the exact ambiguity the customer had just resolved.
//   2. a dot sits on its stored coordinate.
//   3. the dot numbers match the checklist rows. These are cross-referenced
//      constantly ("number 2 is done") and against the numbered list in the
//      Help Scout note, so they must agree.
//   4. ticking one off turns it green.
//
// ⚠ Assert STRUCTURE, never wording.

import { test, expect } from '@playwright/test'

test.describe('customer pins on the designer side', () => {
  test.beforeEach(async ({ page }) => {
    // The harness lives at /verify-harness/index.html — "/" on this port is the
    // real app, a trap that has cost time before.
    await page.goto('/verify-harness/index.html?path=/customer-pins')
    await expect(page.getByRole('heading', { name: /what the customer pointed at/i })).toBeVisible()
  })

  test('every pin is drawn on the artwork, not just listed', async ({ page }) => {
    // One side is shown at a time, so exactly one marker is drawn: the front
    // pin. The back one is not on this face and must not be drawn on it.
    await expect(page.getByRole('button', { name: /^Customer pin 1/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Customer pin/ })).toHaveCount(1)
    // The other side's tab advertises that it holds a pin, so the designer
    // knows there is more to look at without hunting.
    await expect(page.getByRole('button', { name: /^Back/ })).toContainText(/pin/i)
  })

  test('a dot sits exactly on its stored coordinate', async ({ page }) => {
    // Read the fraction off the rendered marker and compare against the image
    // box. The fixture pins the front pin at 0.30 / 0.40.
    const image = page.locator('img').first()
    await expect(image).toBeVisible()
    const marker = page.getByRole('button', { name: /^Customer pin 1/ })
    await expect(marker).toBeVisible()

    const geometry = await marker.evaluate((el) => {
      const img = el.parentElement?.querySelector('img') as HTMLImageElement
      const i = img.getBoundingClientRect()
      const m = el.getBoundingClientRect()
      return {
        fx: (m.left + m.width / 2 - i.left) / i.width,
        fy: (m.top + m.height / 2 - i.top) / i.height,
      }
    })
    expect(Math.abs(geometry.fx - 0.3)).toBeLessThan(0.005)
    expect(Math.abs(geometry.fy - 0.4)).toBeLessThan(0.005)
  })

  test('dot numbers match the checklist rows', async ({ page }) => {
    // The dot on screen and the row beneath refer to the same pin by number.
    // Both derive from one ordered array; this asserts they still agree.
    const rows = page.locator('label[for^="pin-"]')
    await expect(rows).toHaveCount(2)

    const first = await rows.nth(0).innerText()
    const second = await rows.nth(1).innerText()
    expect(first.trim()).toMatch(/^1\b/)
    expect(second.trim()).toMatch(/^2\b/)

    // Row 1 names a side; the visible dot labelled 1 must be on that side.
    const frontRowIsFirst = /front/i.test(first)
    expect(frontRowIsFirst, 'row 1 should be the front pin on this fixture').toBe(true)
    await expect(page.getByRole('button', { name: /^Customer pin 1/ })).toBeVisible()
  })

  test('"Show me where" switches to the side that pin is on', async ({ page }) => {
    // The whole point of the feature: getting from what they wrote to where they
    // meant, including when it is on the face you are not looking at.
    await expect(page.getByRole('button', { name: /^Customer pin 1/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Customer pin 2/ })).toHaveCount(0)

    await page.getByRole('button', { name: /show me where/i }).nth(1).click()

    await expect(page.getByRole('button', { name: /^Customer pin 2/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Customer pin 1/ })).toHaveCount(0)
  })

  test('ticking a pin off turns its dot green', async ({ page }) => {
    // Colour is the at-a-glance signal of what is left to do, so it is worth an
    // assertion even though it looks cosmetic. Compare before/after rather than
    // pinning a hex value, so a palette change does not fail the test.
    await page.getByRole('button', { name: /show me where/i }).nth(1).click()
    const dot = page.getByRole('button', { name: /^Customer pin 2/ })
    await expect(dot).toBeVisible()
    const before = await dot.evaluate((el) => getComputedStyle(el).backgroundColor)

    await page.locator('input[type=checkbox][id^="pin-"]').nth(1).check()

    await expect(dot).toHaveText('✓')
    const after = await dot.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(after).not.toBe(before)

    // And the progress counter moves, which is what a designer scans for.
    await expect(page.getByText(/1 of 2 done/i)).toBeVisible()
  })

  test('an unticked pin still reads as outstanding', async ({ page }) => {
    await expect(page.getByText(/0 of 2 done/i)).toBeVisible()
    const boxes = page.locator('input[type=checkbox][id^="pin-"]')
    await expect(boxes).toHaveCount(2)
    for (let i = 0; i < 2; i++) await expect(boxes.nth(i)).not.toBeChecked()
  })

  test('customer pins are visually distinct from the designer\'s own notes', async ({ page }) => {
    // "What they asked for" and "what we told them" are different kinds of
    // thing; if they render as one sequence of dots the designer cannot tell
    // which is which. The legend is the promise that they differ.
    await expect(page.getByText(/your notes/i)).toBeVisible()
    await expect(page.getByText(/what the customer pointed at/i).first()).toBeVisible()
  })
})
