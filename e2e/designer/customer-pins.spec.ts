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

// ── Discoverability on the proof page ────────────────────────────────────────
//
// The panel above worked; nothing pointed at it. A real customer (28 Jul 2026)
// pinned a spot on his card and the proof page's only signal was a button
// labelled "Add a note" — because the label counted the designer's own notes and
// ignored the customer's pins entirely. The strip that exists to pull a change
// request to the top of the page quoted the comment and dropped the pins that
// arrived with it, so the path a designer actually takes (read the request →
// "Add a new version") ran straight past the bit where the customer said WHERE.
//
// These tests are about being FOUND, not about the panel working.
//
// ⚠ Assert STRUCTURE, never wording.

test.describe('a customer pin makes itself known on the proof page', () => {
  test.beforeEach(async ({ page }) => {
    // 'changes' in the id puts the fixture proof in the changes_requested
    // bucket, which is what renders the strip. See mock-supabase.
    await page.goto('/verify-harness/index.html?path=/proofs/p-open-changes')
    await expect(page.getByRole('heading', { name: /realise/i })).toBeVisible()
  })

  test('the change-request strip lists what the customer pointed at', async ({ page }) => {
    // The regression this whole change exists to prevent: the strip showing the
    // comment while the pins that came with it stay invisible.
    const strip = page.locator('section').filter({ hasText: /customer requested changes/i }).last()
    await expect(strip.getByRole('listitem')).toHaveCount(2)
    await expect(strip.getByRole('button', { name: /show me/i })).toHaveCount(2)
  })

  test('strip rows carry the same numbers as the panel', async ({ page }) => {
    // A designer cross-references these constantly ("number 2 is done"). The
    // numbering is computed once and shared, and this is what proves it.
    const strip = page.locator('section').filter({ hasText: /customer requested changes/i }).last()
    const rows = strip.getByRole('listitem')
    await expect(rows.nth(0)).toContainText(/^1/)
    await expect(rows.nth(1)).toContainText(/^2/)
  })

  test('the pins are drawn on the artwork already on the page', async ({ page }) => {
    // The most direct answer to "where did they mean" is a dot on the card the
    // designer is already looking at — one per face, not both on one.
    const hero = page.getByRole('button', { name: /open version 1 detail/i })
    await expect(hero.locator('span[aria-hidden="true"]')).toHaveCount(2)
  })

  test('the notes button names outstanding pins rather than counting our own notes', async ({ page }) => {
    // The exact failure reported: with a customer pin waiting and no designer
    // notes written, the only way in read "Add a note" — indistinguishable from
    // a proof with nothing on it at all.
    const button = page.getByRole('button', { name: /pin/i }).filter({ hasNotText: /show me/i })
    await expect(button).toHaveCount(1)
    await expect(button).toContainText(/2/)
  })

  test('"Show me" opens the panel on that pin\'s own face', async ({ page }) => {
    // Pin 2 is on the back; the panel defaults to the front, so landing on the
    // back proves the click carried the designer to the right place.
    const strip = page.locator('section').filter({ hasText: /customer requested changes/i }).last()
    await strip.getByRole('button', { name: /show me/i }).nth(1).click()

    await expect(page.getByRole('heading', { name: /notes on v1/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Customer pin 2/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Customer pin 1/ })).toHaveCount(0)
  })

  test('reopening from the button lands on the artwork, not the last pin clicked', async ({ page }) => {
    // Focus is a property of the click that carried it, not sticky state — a
    // designer opening the panel cold should not be dropped somewhere they did
    // not ask for.
    const strip = page.locator('section').filter({ hasText: /customer requested changes/i }).last()
    await strip.getByRole('button', { name: /show me/i }).nth(1).click()
    await expect(page.getByRole('button', { name: /^Customer pin 2/ })).toBeVisible()
    await page.getByRole('button', { name: /^close$/i }).click()

    await page.getByRole('button', { name: /pin/i }).filter({ hasNotText: /show me/i }).click()
    await expect(page.getByRole('button', { name: /^Customer pin 1/ })).toBeVisible()
  })
})
