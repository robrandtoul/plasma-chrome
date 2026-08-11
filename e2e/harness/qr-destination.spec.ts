// The customer-page QR panel for qcrd.uk short links.
//
// What this exists to catch: a short-link QR encodes a token, not an address.
// `https://qcrd.uk/dgceFH7` decodes perfectly whether it points at the
// customer's own review page or at a stranger's, so this panel is the only
// place on the whole proof where a customer can tell the difference. If the
// destination row stopped rendering, nothing would look broken — the panel
// would just quietly go back to showing an opaque token, and a wrong QR would
// reach print with everybody having signed it off.
//
// The rig (?path=/qr-destination, verify-harness/entry.tsx) mounts one card per
// state that renders differently, in a fixed order, against the mocked vCard
// client (verify-harness/mock-vcard.ts). Card order is the rig's contract:
//   1 redirect (long URL)  2 hosted vCard  3 draft  4 no address  5 no card

import { expect, test } from '@playwright/test'

const RIG = '/verify-harness/index.html?path=/qr-destination'

test.beforeEach(async ({ page }) => {
  await page.goto(RIG)
  // The panel resolves each slug asynchronously; wait for the set to settle.
  await expect(page.locator('article')).toHaveCount(5)
})

test('a redirect QR shows where it leads, not just the token that is printed', async ({ page }) => {
  const card = page.locator('article').first()
  // The short link is on the card (it is what prints) AND the destination host
  // is too — the second is the whole point, and is not derivable from the first.
  await expect(card).toContainText('qcrd.uk/qr-redirect')
  await expect(card).toContainText('google.com/search')
  // The search term survives into the readable summary: it is the only part of
  // a 800-character Google URL that says where the link actually goes.
  await expect(card).toContainText('harborline plumbing reviews')
})

test('the full address is available but folded away until asked for', async ({ page }) => {
  const card = page.locator('article').first()
  const disclosure = card.locator('details')
  await expect(disclosure).toHaveCount(1)

  // Closed by default: these URLs run to hundreds of characters of tracking,
  // and pasting that wall in front of someone makes the destination harder to
  // check, not easier.
  await expect(disclosure.locator('span')).toBeHidden()
  await disclosure.locator('summary').click()
  await expect(disclosure.locator('span')).toBeVisible()

  // And what it reveals is the verbatim URL — the summary above it is a
  // summary, so the unabridged fact has to remain reachable.
  const full = (await disclosure.locator('span').innerText()).trim()
  expect(full.startsWith('https://')).toBe(true)
  expect(full.length).toBeGreaterThan(400)
})

test('a long destination never makes the page scroll sideways', async ({ page }) => {
  await page.locator('details').first().locator('summary').click()
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  )
  expect(overflows).toBe(false)
})

test('field labels stay inside their column instead of printing over the value', async ({ page }) => {
  // Regression: the label column is a fixed 80px and `.eyebrow` sets
  // white-space: nowrap, so a label wider than 80px could not wrap — it
  // overflowed its cell and painted over the value beside it, which reads as
  // corruption rather than as a layout bug.
  //
  // ⚠ Measure content overflow (scrollWidth vs clientWidth), NOT bounding
  // boxes. A box does not grow when its text spills out of it, so comparing
  // the label's right edge to the value's left edge reports no overlap even
  // while the two are visibly printed on top of each other — an earlier
  // version of this test did exactly that and passed against the live bug.
  const overflowing = await page.evaluate(() =>
    Array.from(document.querySelectorAll('div[class*="grid-cols-[80px"]'))
      .map((g) => g.children[0])
      .filter((label): label is HTMLElement => label instanceof HTMLElement)
      .filter((label) => label.scrollWidth > label.clientWidth)
      .map((label) => label.innerText.trim()),
  )
  expect(overflowing).toEqual([])
})

test('a hosted vCard still renders its contact fields', async ({ page }) => {
  // The same slug space serves vCards and redirects, and only the card row says
  // which. Branching on that must not cost the vCard view its fields.
  const card = page.locator('article').nth(1)
  await expect(card).toContainText('Dana Rowe')
  await expect(card).toContainText('dana@harborlineplumbing.co.uk')
  await expect(card).toContainText('+44 20 7946 0812')
  // No destination disclosure on a vCard: there is no external address.
  await expect(card.locator('details')).toHaveCount(0)
})

test('a redirect with no address saved says so instead of showing a blank row', async ({ page }) => {
  const card = page.locator('article').nth(3)
  await expect(card).toContainText('qcrd.uk/qr-noaddress')
  // Nothing to disclose, because there is no address — the failure state must
  // not render as an empty "goes to" that reads like a destination of nothing.
  await expect(card.locator('details')).toHaveCount(0)
})

test('every card renders without a React error', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' && m.text().includes('[harness] uncaught render error')) {
      errors.push(m.text())
    }
  })
  await page.goto(RIG)
  await expect(page.locator('article')).toHaveCount(5)
  expect(errors).toEqual([])
})
