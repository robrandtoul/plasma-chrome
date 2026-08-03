// The two command palettes: the admin feature search (the "Search admin…"
// box + "/" inside the admin shell) and the designer command palette
// (?path=/palette, the ⌘K surface).
//
// Why these exist: the palettes are the only route to a lot of surface area —
// the admin one is how anyone reaches the Settings sub-sections and the
// unlisted pages (Demo data has NO sidebar entry at all), and the designer
// one is the only global project search. Both are pure client-side machinery
// (a fuzzy scorer, a debounced RPC, a combobox contract), which is exactly
// the kind of code a refactor breaks without any page looking different at a
// glance. The real failures each spec catches:
//
//   1. the palette stops opening from its triggers (button or "/"), which
//      silently orphans every destination that only it can reach.
//   2. the fuzzy matcher regresses — a partial word across a word boundary,
//      or a one-letter typo, stops ranking the obvious destination first, so
//      Enter starts opening the WRONG page. Asserted by landing: after
//      Enter, the sidebar's aria-current and the destination page's own
//      structure prove where we ended up, never the option's label text.
//   3. the combobox a11y contract breaks (aria-activedescendant / a
//      moving aria-selected) — keyboard users lose the palette entirely.
//   4. the designer palette's two-character gate breaks: a one-letter query
//      must never fire the server-side proof search, and a two-letter one
//      must merge the fixture projects IN FRONT of the page destinations.
//   5. no-match shows the empty state rather than crashing or navigating.
//
// The mock dashboard_list RPC ignores its p_search argument and always
// returns the eight fixture projects, so proof-search assertions are about
// plumbing (gate, ordering, grouping), never about server-side ranking.
//
// ⚠ Assert STRUCTURE, never wording.

import { test, expect, type Page } from '@playwright/test'

const HARNESS = '/verify-harness/index.html?path='

// Same collector as admin-smoke: fail on any console error that isn't the
// offline harness's by-design resource failures.
function collectErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    if (/Failed to load resource|net::ERR_|ERR_TUNNEL|ERR_PROXY|ERR_CONNECTION/i.test(text)) return
    errors.push(text)
  })
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
  return errors
}

// ── The admin feature search ────────────────────────────────────────────────

// Opens the palette from the sidebar search box (its one always-visible
// trigger) and hands back the combobox input.
async function openAdminSearch(page: Page) {
  await page.goto(HARNESS + '/admin')
  await expect(page.locator('main').getByRole('heading').first()).toBeVisible()
  await page.locator('aside > button').click()
  const input = page.getByRole('combobox')
  await expect(input).toBeVisible()
  return input
}

test.describe('admin feature search', () => {
  test('opens from the sidebar box and lists the whole directory grouped', async ({ page }) => {
    const errors = collectErrors(page)
    await openAdminSearch(page)

    // Browse mode (no query) is the full registry — well beyond the sidebar's
    // own entries, because the deep destinations (Settings sections, Demo
    // data) only exist here. Grouped under headers, with the highlight
    // resting on the first row.
    const options = page.getByRole('option')
    expect(await options.count()).toBeGreaterThanOrEqual(20)
    expect(await page.getByRole('listbox').locator('.eyebrow').count()).toBeGreaterThanOrEqual(3)
    await expect(options.first()).toHaveAttribute('aria-selected', 'true')
    expect(errors).toEqual([])
  })

  test('"/" opens it from anywhere in the admin shell', async ({ page }) => {
    await page.goto(HARNESS + '/admin/analytics')
    await expect(page.locator('main').getByRole('heading').first()).toBeVisible()
    await page.keyboard.press('/')
    await expect(page.getByRole('combobox')).toBeVisible()
  })

  test('a partial word across a word boundary ranks the right page first, and Enter opens it', async ({ page }) => {
    const input = await openAdminSearch(page)

    // "leadt" is not a prefix of any label word — it only matches "lead
    // times" once the space is dropped. That compact-form tier is what lets
    // half-typed queries land, so it gets its own test. Enter must open the
    // TOP result: proven by where we land (the Catalogue data page with its
    // lead-times tab current, and the sidebar lit on Catalogue data), never
    // by reading the option's caption.
    await input.fill('leadt')
    await expect(page.getByRole('option').first()).toBeVisible()
    await input.press('Enter')

    await expect(page.getByRole('combobox')).toHaveCount(0)
    await expect(page.locator('aside nav a[aria-current="page"]')).toHaveAttribute(
      'href',
      '/admin/catalogue',
    )
    await expect(
      page.locator('main a[href="/admin/catalogue/lead-times"][aria-current="page"]'),
    ).toBeVisible()
  })

  test('a one-letter typo still finds the destination', async ({ page }) => {
    const input = await openAdminSearch(page)

    // "analitics" matches nothing by prefix, substring or subsequence — only
    // the edit-distance tier can rescue it. If that tier regresses, this
    // query returns nothing (or something else wins) and the landing
    // assertions below break.
    await input.fill('analitics')
    await expect(page.getByRole('option').first()).toBeVisible()
    await input.press('Enter')

    await expect(page.locator('aside nav a[aria-current="page"]')).toHaveAttribute(
      'href',
      '/admin/analytics',
    )
    // The Analytics page's own tab strip proves the page mounted.
    await expect(page.locator('main div.border-b > button')).toHaveCount(6)
  })

  test('gibberish shows the empty state instead of crashing or navigating', async ({ page }) => {
    const errors = collectErrors(page)
    const input = await openAdminSearch(page)

    await input.fill('zzzqqxx')
    await expect(page.getByRole('option')).toHaveCount(0)
    // Still open, still typed, still recoverable.
    await expect(input).toBeVisible()
    await expect(page.getByRole('button', { name: /clear/i })).toBeVisible()
    expect(errors).toEqual([])
  })

  test('arrow keys move the active option', async ({ page }) => {
    const input = await openAdminSearch(page)
    const options = page.getByRole('option')

    // The combobox contract: the input points at the active row via
    // aria-activedescendant and exactly that row is aria-selected. ArrowDown
    // must move both together — this is what a screen reader announces.
    await expect(input).toHaveAttribute('aria-activedescendant', 'admin-search-opt-0')
    await input.press('ArrowDown')
    await expect(input).toHaveAttribute('aria-activedescendant', 'admin-search-opt-1')
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(options.first()).toHaveAttribute('aria-selected', 'false')
  })
})

// ── The designer command palette (?path=/palette) ───────────────────────────

// The rig mounts DesignerSearch open with no other routes, so these specs
// never press Enter or click a row — navigation has nowhere to land here.
// Kind boundaries render one group header each, so the header count is the
// structural tell for "proofs and pages" (2) vs "pages only" (1).
const GROUP_HEADERS = '#designer-search-listbox p'

test.describe('designer command palette', () => {
  test('browse mode lists page destinations only', async ({ page }) => {
    const errors = collectErrors(page)
    await page.goto(HARNESS + '/palette')
    const input = page.getByRole('combobox')
    await expect(input).toBeVisible()

    const options = page.getByRole('option')
    expect(await options.count()).toBeGreaterThanOrEqual(5)
    // One kind on screen → one group header, and no row carries a proof
    // status pill, because no proof search has run.
    await expect(page.locator(GROUP_HEADERS)).toHaveCount(1)
    await expect(page.getByRole('option').locator('span.pill')).toHaveCount(0)
    await expect(options.first()).toHaveAttribute('aria-selected', 'true')
    expect(errors).toEqual([])
  })

  test('two characters pull the fixture projects in, listed before the pages', async ({ page }) => {
    await page.goto(HARNESS + '/palette')
    const input = page.getByRole('combobox')
    await expect(input).toBeVisible()
    const options = page.getByRole('option')

    // 'qu' filters the pages to a single hit and (after the debounce) merges
    // the eight fixture projects from dashboard_list ABOVE it: 9 rows under
    // two group headers. The first row is a project (it carries the status
    // pill), the last is the page destination (it doesn't) — the ordering
    // that puts "the job I'm looking for" before "a page I could open".
    await input.fill('qu')
    await expect(options).toHaveCount(9)
    await expect(page.locator(GROUP_HEADERS)).toHaveCount(2)
    await expect(options.first().locator('span.pill')).toHaveCount(1)
    await expect(options.last().locator('span.pill')).toHaveCount(0)
  })

  test('a one-character query never fires the proof search', async ({ page }) => {
    await page.goto(HARNESS + '/palette')
    const input = page.getByRole('combobox')
    await expect(input).toBeVisible()
    const options = page.getByRole('option')

    // Start from the settled two-character state (9 rows), then delete one
    // character: the proof rows must drop instantly, leaving only the single
    // page hit. If the two-character gate regressed, the mock's
    // always-returns-8 dashboard_list would keep 8 proof rows on screen and
    // this count breaks.
    await input.fill('qu')
    await expect(options).toHaveCount(9)
    await input.press('Backspace')
    await expect(options).toHaveCount(1)
    await expect(page.locator(GROUP_HEADERS)).toHaveCount(1)
    await expect(options.locator('span.pill')).toHaveCount(0)
  })

  test('clearing the query restores browse mode', async ({ page }) => {
    await page.goto(HARNESS + '/palette')
    const input = page.getByRole('combobox')
    await expect(input).toBeVisible()

    await input.fill('qu')
    await expect(page.locator(GROUP_HEADERS)).toHaveCount(2)

    await page.getByRole('button', { name: /clear/i }).click()
    await expect(page.locator(GROUP_HEADERS)).toHaveCount(1)
    await expect(page.getByRole('option').locator('span.pill')).toHaveCount(0)
    await expect(input).toHaveValue('')
  })

  test('arrow keys move the active option', async ({ page }) => {
    await page.goto(HARNESS + '/palette')
    const input = page.getByRole('combobox')
    await expect(input).toBeVisible()
    const options = page.getByRole('option')

    await expect(input).toHaveAttribute('aria-activedescendant', 'designer-search-opt-0')
    await input.press('ArrowDown')
    await expect(input).toHaveAttribute('aria-activedescendant', 'designer-search-opt-1')
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(options.first()).toHaveAttribute('aria-selected', 'false')
  })
})
