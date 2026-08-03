// The Order log (?path=/orders/log) — the searchable archive beside the work
// queue: stats strip, bucket chips, dense row list, and a detail panel showing
// everything on file for one order.
//
// What these specs exist to catch:
//
//   1. the stats strip drifting from the list it summarises. The tiles and
//      the rows are computed from the same loaded set (src/lib/orderLog.ts),
//      so the Awaiting tile must equal the Awaiting chip, and the All chip
//      must equal the number of rows actually rendered — a mismatch means a
//      figure is lying about the data on screen.
//   2. search losing its AND semantics: "globex satin" must find only the
//      order matching BOTH terms, not everything matching either. Terms span
//      fields (customer + spec), which is the whole point of the helper.
//   3. a status-bucket chip filtering to a different set than the count it
//      advertises, or the empty Cancelled bucket rendering a dead chip.
//   4. the row → detail flow breaking: clicking a row must mark it current
//      and open the panel with the artwork, the links out, the checkout
//      breakdown summing to the header total, and the lifecycle timeline.
//      (Deep-linking via ?order= isn't reachable in the harness's memory
//      router, so rows are clicked.)
//   5. "More from this customer" selecting a related order without moving the
//      list's current marker — the designer loses track of where they are.
//   6. the admin dispatch enrichment regressing: shipped/delivered state
//      comes from a separate RPC and must override the status pill only on
//      the rows it applies to (o9 delivered, o10 shipped in the fixtures).
//
// ⚠ Assert STRUCTURE, never wording.

import { test, expect, type Page, type Locator } from '@playwright/test'

// The list rows are the direct button children of the list container. The
// detail panel shares the container classes but none of its buttons are
// direct children, so this stays scoped to rows. (No roles distinguish them —
// the rows are plain buttons.)
function listRows(page: Page): Locator {
  return page.locator('div.overflow-hidden.rounded-\\[14px\\] > button')
}

// Trailing count a chip or tile advertises ("All 16" → 16).
async function trailingCount(el: Locator): Promise<number> {
  const match = (await el.innerText()).match(/(\d+)\s*$/)
  expect(match, 'element should end with a count').not.toBeNull()
  return Number(match![1])
}

test.describe('order log', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/verify-harness/index.html?path=/orders/log')
    await expect(page.getByRole('heading', { name: /order log/i })).toBeVisible()
    await expect(listRows(page).first()).toBeVisible()
  })

  test('renders without errors and the stats strip agrees with the list', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error' && msg.text().includes('[harness] uncaught render error')) {
        consoleErrors.push(msg.text())
      }
    })
    await page.goto('/verify-harness/index.html?path=/orders/log')
    await expect(listRows(page).first()).toBeVisible()
    expect(consoleErrors).toEqual([])

    // Four stat tiles (StatCard renders no role, so the tiles are located as
    // the stats grid's direct card children) plus the weekly chart.
    const tiles = page.locator('div.grid-cols-2 > div.rounded-xl')
    await expect(tiles).toHaveCount(4)
    await expect(page.locator('svg[role="img"]')).toBeVisible()

    // Tiles are ordered: paid-30d, awaiting, median, placed. The awaiting
    // tile's big number must equal the Awaiting bucket chip's count — both
    // derive from the same rows, so disagreement means one of them is wrong.
    const awaitingTileValue = Number(await tiles.nth(1).locator('div.font-mono').innerText())
    const chips = page.locator('button[aria-pressed]')
    const awaitingChipCount = await trailingCount(chips.nth(1))
    expect(awaitingTileValue).toBe(awaitingChipCount)

    // The All chip's count equals the rows actually rendered (the fixture set
    // is far below the show-more window, so nothing is held back).
    const allCount = await trailingCount(chips.first())
    await expect(listRows(page)).toHaveCount(allCount)

    // Every tile carries a numeric headline (a NaN or blank means a stat
    // computation fell over silently).
    for (let i = 0; i < 4; i++) {
      const value = await tiles.nth(i).locator('div.font-mono').innerText()
      expect(value.trim()).toMatch(/^\d|^</) // "11", "5", "<1d", "2"…
    }
  })

  test('status-bucket chips filter the list to exactly the count they advertise', async ({ page }) => {
    const chips = page.locator('button[aria-pressed]')
    // Five chips: All + the four non-empty buckets. Cancelled is empty in the
    // fixtures and must not render a dead chip.
    await expect(chips).toHaveCount(5)
    await expect(chips.first()).toHaveAttribute('aria-pressed', 'true')

    // Click the third chip (the Paid bucket): it becomes the pressed one and
    // the list shrinks to exactly its advertised count.
    const paidChip = chips.nth(2)
    const paidCount = await trailingCount(paidChip)
    expect(paidCount).toBeGreaterThan(0)
    await paidChip.click()
    await expect(paidChip).toHaveAttribute('aria-pressed', 'true')
    await expect(chips.first()).toHaveAttribute('aria-pressed', 'false')
    await expect(listRows(page)).toHaveCount(paidCount)

    // Back to All restores the full list.
    const allCount = await trailingCount(chips.first())
    await chips.first().click()
    await expect(listRows(page)).toHaveCount(allCount)
  })

  test('multi-term search ANDs across fields', async ({ page }) => {
    const searchBox = page.locator('input[type=search]')
    const all = await listRows(page).count()

    // One term: every Globex order (two grouped steel/custom + one satin).
    await searchBox.fill('globex')
    await expect(listRows(page)).toHaveCount(3)

    // Two terms AND together across different fields — customer AND spec —
    // leaving only the satin order. OR semantics would keep all three.
    await searchBox.fill('globex satin')
    await expect(listRows(page)).toHaveCount(1)
    await expect(listRows(page).first()).toContainText('ORD-O6')

    // A reference search finds the same order by a different field.
    await searchBox.fill('ord-o6')
    await expect(listRows(page)).toHaveCount(1)

    await searchBox.fill('')
    await expect(listRows(page)).toHaveCount(all)
  })

  test('clicking a row opens the detail panel with artwork, links, breakdown and history', async ({ page }) => {
    // o5: a paid Acme order with artwork on file, a failed invoice, delivery
    // details, and a two-moment history (created → paid).
    const row = listRows(page).filter({ hasText: 'ORD-O5' }).first()
    await expect(page.locator('button[aria-current="true"]')).toHaveCount(0)
    await row.click()
    await expect(row).toHaveAttribute('aria-current', 'true')

    const detail = page.locator('div.lg\\:sticky').first()
    await expect(detail.getByRole('heading', { name: /acme/i })).toBeVisible()

    // The header total is the same figure the checkout breakdown sums to —
    // orderTotal() feeds both, so it must appear (cards 449 + shipping 12.90).
    await expect(detail.getByText('£461.90').first()).toBeVisible()

    // Artwork: one image for this proof, and it opens the lightbox.
    const artworkThumb = detail.locator('img')
    await expect(artworkThumb).toHaveCount(1)
    await artworkThumb.first().click()
    const lightbox = page.getByRole('dialog')
    await expect(lightbox).toBeVisible()
    await expect(lightbox.locator('img')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Links out: the project link and the review-and-place link carry real
    // route targets; the pay-link copy is a button (clipboard, not a link).
    await expect(detail.getByRole('link', { name: /open project/i })).toHaveAttribute('href', '/proofs/p-o5')
    await expect(detail.getByRole('link', { name: /review & place/i })).toHaveAttribute('href', '/orders/o5/place')
    await expect(detail.getByRole('button', { name: /copy pay link/i })).toBeVisible()

    // The lifecycle timeline: o5 has exactly two recorded moments.
    await expect(detail.locator('ol > li')).toHaveCount(2)
  })

  test('"More from this customer" selects the related order and moves the current marker', async ({ page }) => {
    await listRows(page).filter({ hasText: 'ORD-O5' }).first().click()
    const detail = page.locator('div.lg\\:sticky').first()
    await expect(detail.getByRole('heading', { name: /acme/i })).toBeVisible()

    // o1 shares o5's company, so it appears as a related order; selecting it
    // re-keys the panel and the list's current marker follows.
    await detail.locator('button').filter({ hasText: 'ORD-O1' }).first().click()

    const currentRow = listRows(page).filter({ hasText: 'ORD-O1' }).first()
    await expect(currentRow).toHaveAttribute('aria-current', 'true')
    await expect(listRows(page).filter({ hasText: 'ORD-O5' }).first()).not.toHaveAttribute('aria-current', 'true')

    // o1's history has three moments (created, link opened, one reminder) —
    // proof the panel re-rendered for the new selection rather than keeping
    // o5's two.
    await expect(detail.locator('ol > li')).toHaveCount(3)
  })

  test('dispatch enrichment overrides the status pill only where a parcel went out', async ({ page }) => {
    // The harness signs in as an admin, so the shipping RPC returns o9
    // delivered and o10 shipped. Their rows must say so instead of the bare
    // fulfilled status — while every other row keeps its own status.
    await expect(listRows(page).filter({ hasText: 'ORD-O9' }).first()).toContainText(/delivered/i)
    await expect(listRows(page).filter({ hasText: 'ORD-O10' }).first()).toContainText(/shipped/i)
    // A row the RPC says nothing about is untouched by the enrichment.
    await expect(listRows(page).filter({ hasText: 'ORD-O5' }).first()).not.toContainText(/shipped|delivered/i)
  })
})
