// Moving an uploaded image between front and back on the new-version form
// (/proofs/:id/versions/new).
//
// The image grid renders SLOTS, and a fresh upload is drawn only where its
// (recipient, side) coordinate matches one. That makes the "Move to front /
// back" control on each card load-bearing in a way it doesn't look: on a
// two-sided SHARED project every identity owns exactly ONE side — the shared
// design owns the front, each named recipient owns the back — so flipping the
// side alone lands the image on a coordinate that is not a slot. The card
// stops being drawn, while the save gate keeps counting the image and blocks
// on "assign every image to a recipient". The designer is then staring at a
// correct-looking form, an unsaveable button, and a reason pointing at an
// image they cannot see anywhere on the page. That happened to a real
// three-recipient card (The Sourdough Company).
//
// What each spec catches:
//   * a Move control offered where the move has nowhere to land — one click
//     and the upload is gone from the page but still jamming Save;
//   * a move that silently drops the image instead of carrying its recipient
//     across with it;
//   * the ordinary two-sided case losing its Move control as collateral —
//     there both sides genuinely belong to the same recipient, and shuffling
//     a mis-tagged front onto the back is a normal thing to want.
//
// ⚠ Assert STRUCTURE, never wording: control counts, image counts, and how
// many empty drop zones are left — not the copy on any of them.

import { test, expect, type Page } from '@playwright/test'

const FAMILY = 'input[name="wizard-family"]'

const submit = (page: Page) => page.locator('button[type="submit"]')
const roster = (page: Page) => page.getByRole('group', { name: /names on this order/i })
// The standard grid's section drop zone — the only role=button carrying
// aria-disabled — anchors the image section.
const imageSection = (page: Page) =>
  page.locator('section').filter({ has: page.locator('div[role="button"][aria-disabled]') })
// One <img> per uploaded card. The count is the whole point: an image that
// leaves this set has left the page.
const shownImages = (page: Page) => imageSection(page).locator('img')
const moveControls = (page: Page) => imageSection(page).getByRole('button', { name: /^move to /i })
// Section batch zone + one per EMPTY slot, so the count tracks how many slots
// are still waiting for artwork.
const fileInputs = (page: Page) => imageSection(page).locator('input[type="file"]')

// A real (1×1) JPEG so the file passes the form's image/jpeg accept filter.
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  'base64',
)

// A two-recipient two-sided proof on vf-blank, one upload per empty slot.
// Empty slots sort ahead of filled cards, so nth(1) is always the next one
// waiting — filling them is just the same click repeated.
async function buildTwoSided(page: Page, { shared }: { shared: boolean }) {
  await page.goto('/verify-harness/index.html?path=/proofs/vf-blank/versions/new')
  await expect(page.locator(FAMILY)).toHaveCount(3)
  await page.locator(`label:has(${FAMILY}[value="recipients"])`).click()
  await page.getByRole('combobox').selectOption('vf-mat-steel')

  for (const name of ['Kim Field', 'Sam Ross']) {
    await roster(page).getByRole('textbox').fill(name)
    await roster(page).getByRole('textbox').press('Enter')
  }
  await expect(roster(page).getByRole('button', { name: /^remove /i })).toHaveCount(2)

  if (shared) {
    await page.getByRole('switch', { name: /shared design/i }).click()
    await expect(page.getByRole('switch', { name: /shared design/i })).toHaveAttribute('aria-checked', 'true')
  }

  // Shared collapses the two fronts into one; without it every recipient
  // keeps both sides.
  const slots = shared ? 3 : 4
  for (let i = 0; i < slots; i++) {
    await fileInputs(page).nth(1).setInputFiles({ name: `art-${i}.jpg`, mimeType: 'image/jpeg', buffer: TINY_JPEG })
    await expect(shownImages(page)).toHaveCount(i + 1)
  }
  // Every slot filled: the form is complete and the door is open.
  await expect(submit(page)).toBeEnabled()
}

test.describe('two-sided + shared (one side per identity)', () => {
  test('the shared front offers no move, because there is no single back it could belong to', async ({ page }) => {
    await buildTwoSided(page, { shared: true })

    // Three cards, but only the two named backs can move — asking the shared
    // front to become "a back" has no answer while more than one recipient
    // could own it, so the control is withheld rather than offered and then
    // honoured destructively.
    await expect(shownImages(page)).toHaveCount(3)
    await expect(moveControls(page)).toHaveCount(2)
  })

  test('every move that IS offered keeps its image on the page', async ({ page }) => {
    await buildTwoSided(page, { shared: true })

    // The regression in one line: click the control, count the page. A move
    // that strands its image drops this to 2 and takes Save down with it,
    // blaming an image no longer drawn anywhere.
    await moveControls(page).first().click()
    await expect(shownImages(page)).toHaveCount(3)

    // A named back moved to the front becomes the shared front — the only
    // front this shape has — so the recipient's back slot is now the one
    // thing missing. Save closes on THAT, an empty slot the designer can see
    // and fill, not on a phantom.
    await expect(submit(page)).toBeDisabled()
    await expect(fileInputs(page)).toHaveCount(2)
  })
})

// The blocker this whole area exists to serve is "assign every image to a
// recipient", and it counts images the grid cannot draw — so on its own it can
// only ever name something unreachable. The Undo window is the one route left
// that can still produce such an image: remove a card, drop its recipient, then
// undo, and the image comes back to a slot that no longer exists. It must land
// somewhere the designer can see and clear, or the form is unsaveable for good.
test.describe('an image with no slot left', () => {
  test('is listed with a way to clear it, instead of silently jamming Save', async ({ page }) => {
    await buildTwoSided(page, { shared: true })
    const stranded = () => imageSection(page).getByRole('list')
    await expect(stranded()).toHaveCount(0)

    // Cards sort front-then-name, so the second Remove is Kim's back.
    await imageSection(page).getByRole('button', { name: /^remove$/i }).nth(1).click()
    // Within the Undo window, drop Kim from the roster: her back slot goes
    // with her, and the stashed image has nowhere to return to.
    await roster(page).getByRole('button', { name: /^remove kim field$/i }).click()
    await page.getByRole('button', { name: /^undo$/i }).click()

    // One image back on the page but outside every slot: called out by name,
    // with its own Remove, and Save honestly shut until it's dealt with.
    await expect(stranded().getByRole('listitem')).toHaveCount(1)
    await expect(submit(page)).toBeDisabled()

    await stranded().getByRole('button', { name: /^remove$/i }).click()
    await expect(stranded()).toHaveCount(0)
    await expect(submit(page)).toBeEnabled()
  })
})

test.describe('two-sided, not shared (both sides per recipient)', () => {
  test('a card still moves across, and only its own slot is left waiting', async ({ page }) => {
    await buildTwoSided(page, { shared: false })

    // Here the move is unremarkable: the recipient owns both sides, so the
    // image simply changes side and stays theirs. All four cards can do it.
    await expect(moveControls(page)).toHaveCount(4)
    await expect(fileInputs(page)).toHaveCount(1)

    await moveControls(page).first().click()
    await expect(shownImages(page)).toHaveCount(4)
    // Exactly one slot opened up — the one the image left. Proof the move
    // happened, rather than the click doing nothing at all.
    await expect(fileInputs(page)).toHaveCount(2)
  })
})
