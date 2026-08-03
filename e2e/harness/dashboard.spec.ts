// The designer home page (?path=/dashboard), against the shared fixture set:
// eight dashboard_list projects, the dashboard_tile_counts RPC row
// (6 / 7 / 15 / 3 / 4 / 2 / 1), one three-card bundle (set-1), one
// needs-attention reorder request (p-a2) and one customer-reorder child (p-a1).
//
// What these lock in, and the real failures each exists to catch:
//
//   1. the stat tiles show the SERVER's counts. They come from a dedicated RPC
//      precisely so the headline numbers span every proof in the database, not
//      the loaded subset — a refactor that quietly recomputed them client-side
//      would pass every other test while lying on live.
//   2. a tile is a FILTER: clicking narrows the list to that bucket, clicking
//      again clears it, and picking a second tile swaps rather than stacks.
//      The tile's aria-pressed is the contract a screen reader relies on.
//   3. an empty click-through renders the filtered-empty state, never a blank
//      page with no way back.
//   4. search narrows by customer and clearing restores everything; a search
//      that hits every card of a bundle keeps the bundle gathered as one block.
//   5. the material chips carry honest per-family counts, disable families
//      with nothing in them, and actually filter.
//   6. the status pill and the row's coloured left cap read from ONE bucket
//      (proofBucket) — the exact drift the shared helper was written to end.
//   7. the reason chip, the snooze clock and the ⋯ menu all open IN PLACE.
//      Every one of them sits inside a row that is itself a giant navigate
//      button, so a lost stopPropagation turns "snooze this" into "open the
//      proof" — the most annoying possible regression on this page.
//   8. rows navigate to their proof, and the provenance lines (bundle front
//      door, customer-reorder source) are real links with real destinations.
//
// The mock backend is stateless: pin/snooze writes succeed and vanish, so
// these specs assert popover structure and the page's own optimistic state,
// never a post-refetch change. Desktop only — the harness project runs a
// desktop viewport and the max-md mobile layout never mounts.
//
// ⚠ Assert STRUCTURE, never wording.

import { test, expect, type Page } from '@playwright/test'

// Structural handles, chosen so no assertion rests on copy:
//  - a project row is the only div[role="button"] on this page (the activity
//    feed rows are li[role="button"], so the two can never collide);
//  - the eight toggle tiles are the only buttons in the hero section carrying
//    BOTH aria-label and aria-pressed — the navigating tiles (Orders, Logbook,
//    Flagged) drop aria-pressed by design, so a screen reader never hears
//    "toggle" on a button that changes page;
//  - a tile's headline number is its only 32px count span;
//  - the material chips are the only rounded-full aria-pressed buttons;
//  - section titles are the only eyebrow spans in the soft-ink tone.
const ROW = 'div[role="button"]'
const TILE = 'button[aria-label][aria-pressed]'
const NAV_TILE = 'button[aria-label]:not([aria-pressed])'
const TILE_COUNT = 'span[class*="text-[32px]"]'
const CHIP = 'button.rounded-full[aria-pressed]'
const SECTION_TITLE = 'span.eyebrow.text-ink-soft'
// The BundleBlock root: the only element whose direct child div directly
// contains the bundle front-door link.
const BUNDLE_BLOCK = 'div:has(> div > a[href="/bundles/set-1"])'

async function openDashboard(page: Page) {
  // The harness lives at /verify-harness/index.html — "/" on this port is the
  // real app against a dead backend, a trap that has cost time before.
  await page.goto('/verify-harness/index.html?path=/dashboard')
  // Eight fixture projects on screen = the load settled past the spinner.
  await expect(page.locator(ROW)).toHaveCount(8)
}

// The hero panel is the first <section> in the document; the right-rail
// panels are sections too, so tile locators must scope here.
function heroTiles(page: Page) {
  return page.locator('section').first().locator(TILE)
}

test.describe('dashboard shell', () => {
  test('renders the tiles, the search box and every fixture project without a render error', async ({ page }) => {
    // Attach the listener BEFORE navigation so a crash during first paint is
    // caught — the harness logs this marker for any uncaught render error,
    // which otherwise leaves a half-blank page that still "has rows".
    const renderErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.text().includes('[harness] uncaught render error')) renderErrors.push(msg.text())
    })
    await openDashboard(page)
    await expect(heroTiles(page)).toHaveCount(8)
    await expect(page.getByRole('searchbox')).toBeVisible()
    expect(renderErrors).toEqual([])
  })

  test('the toggle tiles show the fixture counts from the server RPC', async ({ page }) => {
    await openDashboard(page)
    const tiles = heroTiles(page)
    await expect(tiles).toHaveCount(8)
    // DOM order is the pipeline order: needs attention, not viewed, awaiting
    // customer, follow-up, customer responded, approved-this-week, then the
    // parked pair (snoozed — client-derived, no snoozed fixtures — and
    // dormant). Values are the dashboard_tile_counts fixture, zero-padded by
    // the tile itself. If a refactor started counting the loaded rows instead
    // of calling the RPC, needs-attention would read 01 (one flagged row
    // loaded) rather than the server's 06 — exactly the drift this catches.
    const expected = ['06', '07', '15', '04', '03', '02', '00', '01']
    for (let i = 0; i < expected.length; i++) {
      await expect(tiles.nth(i).locator(TILE_COUNT)).toHaveText(expected[i])
    }
    // The order-stage and Flagged tiles exist but navigate to other pages, so
    // they must never advertise themselves as toggles.
    await expect(page.locator('section').first().locator(NAV_TILE)).toHaveCount(4)
  })
})

test.describe('tile filtering', () => {
  test('clicking a tile narrows the list to its bucket and clicking again clears it', async ({ page }) => {
    await openDashboard(page)
    const rows = page.locator(ROW)
    const tile = heroTiles(page).nth(0) // needs attention
    await expect(tile).toHaveAttribute('aria-pressed', 'false')

    await tile.click()
    await expect(tile).toHaveAttribute('aria-pressed', 'true')
    // Exactly one loaded fixture carries a needs-attention rule (the reorder
    // request), and the survivor must be that row — proven structurally by
    // its attention dot, not by any label text.
    await expect(rows).toHaveCount(1)
    await expect(rows.first().locator('span.bg-out')).toHaveCount(1)

    await tile.click()
    await expect(tile).toHaveAttribute('aria-pressed', 'false')
    await expect(rows).toHaveCount(8)
  })

  test('picking a second tile swaps the filter rather than stacking it', async ({ page }) => {
    await openDashboard(page)
    const rows = page.locator(ROW)
    const tiles = heroTiles(page)

    await tiles.nth(4).click() // customer responded → the one replied-by-email fixture
    await expect(rows).toHaveCount(1)

    await tiles.nth(5).click() // approved this week → the two approved fixtures
    await expect(tiles.nth(4)).toHaveAttribute('aria-pressed', 'false')
    await expect(tiles.nth(5)).toHaveAttribute('aria-pressed', 'true')
    await expect(rows).toHaveCount(2)
  })

  test('a bucket with nothing loaded shows the filtered-empty state, never a blank page', async ({ page }) => {
    // The dormant tile counts 1 server-side but the loaded list holds no
    // dormant row — the honest mismatch the fixtures ship with. The page must
    // land on its no-results state (rows and section headers both gone, the
    // tile still visibly active) and a second click must bring everything
    // back. A regression here strands the designer on an empty screen that
    // reads as "no projects exist".
    await openDashboard(page)
    const rows = page.locator(ROW)
    const dormant = heroTiles(page).nth(7)

    await dormant.click()
    await expect(rows).toHaveCount(0)
    await expect(page.locator(SECTION_TITLE)).toHaveCount(0)
    await expect(dormant).toHaveAttribute('aria-pressed', 'true')

    await dormant.click()
    await expect(rows).toHaveCount(8)
  })
})

test.describe('search', () => {
  test('search narrows by customer and clearing restores the list', async ({ page }) => {
    await openDashboard(page)
    const rows = page.locator(ROW)
    const box = page.getByRole('searchbox')

    // A company-name term leaves exactly its one project.
    await box.fill('vandelay')
    await expect(rows).toHaveCount(1)

    // A contact-name term that hits every card of the bundle: all three stay,
    // and they stay GATHERED inside the one bundle block rather than
    // scattering into loose rows — the relationship the block exists to show.
    await box.fill('saba')
    await expect(rows).toHaveCount(3)
    await expect(page.locator(BUNDLE_BLOCK).locator(ROW)).toHaveCount(3)

    await box.fill('')
    await expect(rows).toHaveCount(8)
  })
})

test.describe('material chips', () => {
  test('chips carry per-family counts, disable empty families, and filter the list', async ({ page }) => {
    await openDashboard(page)
    const rows = page.locator(ROW)
    const chips = page.locator(CHIP)

    // Seven chips (All + six families); All is the resting default. Three
    // families have no fixture rows and must be disabled — an enabled dead
    // chip invites a click that empties the list for no visible reason.
    await expect(chips).toHaveCount(7)
    await expect(chips.nth(0)).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator(`${CHIP}[disabled]`)).toHaveCount(3)

    // Per-chip counts, from the fixture data: 8 in all, 6 metal (two of them
    // via the 000376 material_category column, four via the legacy name
    // fallback — both paths must land in one count), 1 paper.
    await expect(chips.nth(0).locator('span.font-mono')).toHaveText('8')
    await expect(chips.nth(1).locator('span.font-mono')).toHaveText('6')
    await expect(chips.nth(2).locator('span.font-mono')).toHaveText('1')

    await chips.nth(1).click() // metal
    await expect(chips.nth(1)).toHaveAttribute('aria-pressed', 'true')
    await expect(chips.nth(0)).toHaveAttribute('aria-pressed', 'false')
    await expect(rows).toHaveCount(6)

    await chips.nth(2).click() // paper
    await expect(rows).toHaveCount(1)

    await chips.nth(0).click() // all
    await expect(rows).toHaveCount(8)
  })
})

test.describe('project rows', () => {
  test('the status pill and the coloured left cap read from one bucket', async ({ page }) => {
    // Pill and cap both derive from proofBucket — the single-source-of-truth
    // fix for the era when a pill could say one thing while the cap (and the
    // tile that counted the proof) said another. Compare computed colours
    // rather than pinning hexes so a palette change cannot fail this.
    await openDashboard(page)
    const rows = page.locator(ROW)
    const readPair = (row: ReturnType<Page['locator']>) =>
      row.evaluate((el) => {
        const pill = el.querySelector('span.pill')
        return {
          cap: getComputedStyle(el).borderLeftColor,
          pill: pill ? getComputedStyle(pill).color : null,
        }
      })

    const attention = rows.filter({ hasText: 'Vandelay' }) // needs-attention bucket
    const quiet = rows.filter({ hasText: 'Atlus' }).first() // not-viewed bucket
    await expect(attention.locator('span.pill')).toHaveCount(1)

    const a = await readPair(attention)
    const q = await readPair(quiet)
    expect(a.pill).not.toBeNull()
    expect(q.pill).not.toBeNull()
    expect(a.cap).toBe(a.pill)
    expect(q.cap).toBe(q.pill)
    // Different buckets must be tellable apart at a glance.
    expect(a.pill).not.toBe(q.pill)
  })

  test('the reason chip opens the resolve popover in place — it must not navigate', async ({ page }) => {
    await openDashboard(page)
    const row = page.locator(ROW).filter({ hasText: 'Vandelay' })

    await row.locator('span.text-out').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    // The popover offers the linked Help Scout thread as a real destination.
    await expect(dialog.locator('a[href^="https://secure.helpscout.net"]')).toBeVisible()
    // The chip sits inside a row that is itself a navigate button; a lost
    // stopPropagation would have swapped the whole page for the proof.
    await expect(page.locator('[data-nav-target]')).toHaveCount(0)

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })

  test('the row strip opens the snooze popover with its presets and note', async ({ page }) => {
    await openDashboard(page)
    const row = page.locator(ROW).filter({ hasText: 'Vandelay' })

    // The action strip is hover-revealed; only the flagged row carries a
    // snooze control at all.
    await row.hover()
    await row.getByRole('button', { name: /snooze/i }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    // Five preset durations + the custom-date entry + cancel, plus the
    // optional note. The counts are code constants, not copy.
    await expect(dialog.getByRole('button')).toHaveCount(7)
    await expect(dialog.locator('textarea')).toHaveCount(1)
    await expect(page.locator('[data-nav-target]')).toHaveCount(0)

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })

  test('the overflow menu lists the row actions with real destinations', async ({ page }) => {
    await openDashboard(page)
    const row = page.locator(ROW).filter({ hasText: 'Atlus' }).first()

    await row.hover()
    await row.locator('button[aria-haspopup="menu"]').click()

    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    // Preview, add-version, Help Scout, and the two pin scopes — five items
    // for an in-progress row with a linked conversation.
    await expect(menu.getByRole('menuitem')).toHaveCount(5)
    // The destinations are real hrefs, not click handlers pointing nowhere.
    await expect(menu.locator('a[href^="/proofs/"][href$="/versions/new"]')).toHaveCount(1)
    await expect(menu.locator('a[href^="https://secure.helpscout.net"]')).toHaveCount(1)

    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })

  test('pinning a row from the strip creates the pinned section on the spot', async ({ page }) => {
    // Pin state is patched client-side after the write (no refetch), so the
    // optimistic result IS the contract: the button flips to its un-pin
    // state, a new section appears at the top holding the pinned row, and
    // the row count stays the same (moved, not duplicated). The stateless
    // mock drops the write itself — persistence is not asserted.
    await openDashboard(page)
    const rows = page.locator(ROW)
    const titlesBefore = await page.locator(SECTION_TITLE).count()
    const row = rows.filter({ hasText: 'Leccy' })

    await row.hover()
    await row.getByRole('button', { name: /pin/i }).click()

    await expect(row.getByRole('button', { name: /unpin/i })).toBeVisible()
    await expect(page.locator(SECTION_TITLE)).toHaveCount(titlesBefore + 1)
    await expect(rows.first()).toContainText('Leccy')
    await expect(rows).toHaveCount(8)
  })

  test('rows navigate to their proof; provenance lines are real links', async ({ page }) => {
    await openDashboard(page)
    const rows = page.locator(ROW)

    // The bundle block renders once, holds its three member rows, and its
    // front door is a real href to the bundle workspace.
    await expect(page.locator('a[href="/bundles/set-1"]')).toHaveCount(1)
    await expect(page.locator(BUNDLE_BLOCK).locator(ROW)).toHaveCount(3)

    // The customer-reorder child links back to the project it was raised
    // from (000373) — provenance as a destination, not a decoration.
    await expect(rows.filter({ hasText: 'Ken Ng' }).locator('a[href="/proofs/p-a2"]')).toHaveCount(1)

    // Clicking a row leaves the dashboard for the proof page. The harness
    // routes any other path to a nav-target stub, so reaching it proves the
    // navigation fired.
    await rows.first().click()
    await expect(page.locator('[data-nav-target]')).toBeVisible()
    await expect(page.locator(ROW)).toHaveCount(0)
  })
})
