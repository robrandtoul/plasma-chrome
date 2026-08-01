// "Point at it" — the customer's optional pins on a change request
// (migration 000347), as the customer meets them.
//
// Runs against the REAL customer page and the REAL anon path on the Atari Corp
// steel fixture, and on BOTH the desktop and phone projects, because the phone
// is the majority surface for change requests and the panel is a different
// component there (a bottom sheet, not a side drawer).
//
// These tests deliberately stop SHORT of pressing Send. Submitting writes a
// proof_event, two annotation rows and an approval row, and that last one flips
// the recipient out of the pending state — so a suite that submitted would pass
// once and then find no "Request changes" button ever again. Everything up to
// the submit is idempotent and is where the regressions were.
//
// ⚠ Assert STRUCTURE, never wording. Staff write and edit notes on this fixture.

import { test, expect, type Page } from '@playwright/test'

const PROOF_ID = 'b7d0796e-c7a5-44d1-860c-e39f92730521'

// Open the change-request panel and return its dialog locator.
async function openPanel(page: Page) {
  // ?preview=1 skips record_proof_view — without it every local run records a
  // real customer view on the shared fixture, feeding the needs-attention
  // rules and waking snoozes. See src/lib/customerProofUrl.ts.
  await page.goto(`/p/${PROOF_ID}?preview=1`)
  await expect(page.getByText('Atari Corp').first()).toBeVisible()

  const request = page.getByRole('button', { name: /^Request changes$/ })
  await expect(
    request,
    'No "Request changes" button — the fixture recipient is probably already ' +
      'approved or in changes-requested state. Reset it via Admin → Demo data.',
  ).toBeVisible()
  await request.click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

// The pin-placement image inside the panel. Named by its alt text, which is
// what a customer using a screen reader is told to do with it.
const placerImage = (dialog: ReturnType<Page['getByRole']>) =>
  dialog.getByRole('img', { name: /tap to point at part of your card/i })

// Tap the placer at a 0-1 fraction of its own box.
//
// Uses a locator click with a position rather than page.mouse.click at absolute
// coordinates: on the phone the placer lives inside the bottom sheet's scroll
// container, so its box can sit outside the visible band. A locator click
// scrolls it into view first; raw mouse coordinates hit whatever is on screen
// at that point instead, which is how the first version of this file "failed"
// on mobile while the feature itself was fine.
async function tapAt(dialog: ReturnType<Page['getByRole']>, fx: number, fy: number) {
  const image = placerImage(dialog)
  await expect(image).toBeVisible()
  const box = await image.boundingBox()
  expect(box).not.toBeNull()
  await image.click({ position: { x: box!.width * fx, y: box!.height * fy } })
}

test.describe('point at it', () => {
  test('the pin step appears BENEATH the notes box, not above it', async ({ page }) => {
    // Order is the whole design: the customer writes what they need first, and
    // pointing is an optional embellishment offered afterwards. Above the notes
    // box it would read as a required drawing step.
    const dialog = await openPanel(page)

    const notes = dialog.getByRole('textbox').nth(1)
    const image = placerImage(dialog)
    await expect(notes).toBeVisible()
    await expect(image).toBeVisible()

    const notesBox = await notes.boundingBox()
    const imageBox = await image.boundingBox()
    expect(notesBox).not.toBeNull()
    expect(imageBox).not.toBeNull()
    expect(imageBox!.y).toBeGreaterThan(notesBox!.y)
  })

  test('it is announced as optional', async ({ page }) => {
    // A customer who reads "point at it" as a required step and cannot work out
    // the interaction on a phone abandons the whole change request. The word
    // matters more than its exact sentence, so match only that.
    const dialog = await openPanel(page)
    await expect(dialog.getByText(/optional/i).first()).toBeVisible()
  })

  test('the placer opens on the FRONT of the card', async ({ page }) => {
    // The regression this exists for: pinImages was handed the images in
    // whatever order the customer-proof-images function returned — no ORDER BY —
    // which on this fixture is back-first. The placer therefore opened on the
    // BACK, so a customer who tapped straight in pinned the wrong face and the
    // pin arrived labelled "back".
    const dialog = await openPanel(page)

    const front = dialog.getByRole('button', { name: /^Front/ })
    const back = dialog.getByRole('button', { name: /^Back/ })
    await expect(front).toBeVisible()
    await expect(back).toBeVisible()

    // Front is listed first...
    const frontBox = await front.boundingBox()
    const backBox = await back.boundingBox()
    expect(frontBox!.x).toBeLessThan(backBox!.x)

    // ...and is the side actually showing. The active pill is the filled one;
    // comparing the two backgrounds avoids pinning a class name.
    const [frontBg, backBg] = await Promise.all([
      front.evaluate((el) => getComputedStyle(el).backgroundColor),
      back.evaluate((el) => getComputedStyle(el).backgroundColor),
    ])
    expect(frontBg, 'Front must be the selected side when the placer opens').not.toBe(backBg)
  })

  test('a tap drops a pin exactly where it was tapped', async ({ page }) => {
    // The coordinate is stored as a 0-1 fraction of the image box and is the
    // entire point of the feature — a pin a few percent out points at the wrong
    // letter. Tap a known fraction, read back what the marker was given.
    const dialog = await openPanel(page)
    const fx = 0.3
    const fy = 0.4
    await tapAt(dialog, fx, fy)

    const marker = dialog.getByRole('button', { name: /^Pin 1/ })
    await expect(marker).toBeVisible()

    const pos = await marker.evaluate((el) => ({
      left: parseFloat((el as HTMLElement).style.left),
      top: parseFloat((el as HTMLElement).style.top),
    }))
    // Sub-pixel tolerance only: a click resolves to whole device pixels, so the
    // fraction lands within a pixel's worth of the target, not exactly on it.
    expect(Math.abs(pos.left - fx * 100)).toBeLessThan(1)
    expect(Math.abs(pos.top - fy * 100)).toBeLessThan(1)
  })

  test('dropping a pin opens a note field for it straight away', async ({ page }) => {
    // A pin with no words is not a change request — it is a dot. The field has
    // to appear without the customer hunting for it.
    const dialog = await openPanel(page)
    await tapAt(dialog, 0.5, 0.5)

    await expect(dialog.getByPlaceholder(/what needs changing here/i)).toBeVisible()
  })

  test('a pin belongs to the side it was placed on', async ({ page }) => {
    // Each side shows only its own pins, and the count rides on the other tab —
    // otherwise a customer switching sides thinks their pin has been lost.
    const dialog = await openPanel(page)

    await tapAt(dialog, 0.3, 0.4)
    await expect(dialog.getByRole('button', { name: /^Pin 1/ })).toBeVisible()

    // Switch to the other side: the front pin must not be drawn on the back.
    await dialog.getByRole('button', { name: /^Back/ }).click()
    await expect(dialog.getByRole('button', { name: /^Pin 1/ })).toHaveCount(0)

    // Place one here; it is pin 2 and it is the only marker on this side.
    await tapAt(dialog, 0.7, 0.25)
    await expect(dialog.getByRole('button', { name: /^Pin 2/ })).toBeVisible()
    await expect(dialog.getByRole('button', { name: /^Pin 1/ })).toHaveCount(0)

    // Going back to the front shows pin 1 again, still numbered 1: the numbers
    // are the customer's list, not a per-side counter.
    await dialog.getByRole('button', { name: /^Front/ }).click()
    await expect(dialog.getByRole('button', { name: /^Pin 1/ })).toBeVisible()
    await expect(dialog.getByRole('button', { name: /^Pin 2/ })).toHaveCount(0)

    // Both are still in the checklist beneath, which is what gets submitted.
    await expect(dialog.getByPlaceholder(/what needs changing here/i)).toHaveCount(2)
  })

  test('a pin can be dragged to adjust it, without spawning a second one', async ({ page }) => {
    // The panel tells the customer they can drag to adjust, so that has to work.
    // The duplicate half of this is the fragile part: the marker sits on top of
    // an image whose own click handler drops a pin, so a drag that let the event
    // through would leave a stray pin behind at the release point every time.
    const dialog = await openPanel(page)
    await tapAt(dialog, 0.3, 0.4)

    const marker = dialog.getByRole('button', { name: /^Pin 1/ })
    await expect(marker).toBeVisible()

    const image = placerImage(dialog)
    const box = await image.boundingBox()
    const from = await marker.boundingBox()
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2)
    await page.mouse.down()
    await page.mouse.move(box!.x + box!.width * 0.6, box!.y + box!.height * 0.7, { steps: 10 })
    await page.mouse.up()

    // Moved to roughly where it was dropped...
    const pos = await marker.evaluate((el) => ({
      left: parseFloat((el as HTMLElement).style.left),
      top: parseFloat((el as HTMLElement).style.top),
    }))
    expect(Math.abs(pos.left - 60)).toBeLessThan(2)
    expect(Math.abs(pos.top - 70)).toBeLessThan(2)

    // ...and it is still the only pin.
    await expect(dialog.getByRole('button', { name: /^Pin \d/ })).toHaveCount(1)
    await expect(dialog.getByPlaceholder(/what needs changing here/i)).toHaveCount(1)
  })

  test('a pin can be removed without touching the change request', async ({ page }) => {
    const dialog = await openPanel(page)
    await tapAt(dialog, 0.4, 0.4)
    await expect(dialog.getByPlaceholder(/what needs changing here/i)).toHaveCount(1)

    await dialog.getByRole('button', { name: /remove pin 1/i }).click()
    await expect(dialog.getByPlaceholder(/what needs changing here/i)).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: /^Pin 1/ })).toHaveCount(0)

    // The notes box — the thing that actually carries the request — survives.
    await expect(dialog.getByRole('textbox').nth(1)).toBeVisible()
  })

  test('the change request can still be sent with no pins at all', async ({ page }) => {
    // Pins are optional end to end. If the Send button ever depends on one, a
    // customer who just wants to type a sentence is stuck.
    const dialog = await openPanel(page)
    await dialog.getByRole('textbox').nth(1).fill('Please adjust the spacing.')
    const send = dialog.getByRole('button', { name: /send/i })
    await expect(send).toBeEnabled()
    // Deliberately not clicked — see the file header.
  })
})
