// Every admin surface the harness can reach, opened once each — cheap
// insurance across ~16 screens whose shared failure mode is expensive: an
// uncaught render error white-screens the page for the whole team, and
// nothing else in the repo would notice, because the admin pages have no
// component tests at all. Each screen here has broken exactly this way
// before (a fixture shape drifting under a page, a view losing a column) and
// the first report came from a human mid-task.
//
// What these lock in, and the real failure each exists to catch:
//
//   1. every route MOUNTS: a heading landmark renders inside <main>, the
//      harness logged no '[harness] uncaught render error', and no other
//      console.error or uncaught page error fired — React's own warnings are
//      the first symptom of the next crash, so they fail too. Resource-load
//      errors are exempt: the harness deliberately runs offline behind a
//      dead proxy, so external fetches (Google Fonts) fail BY DESIGN.
//   2. the grouped sidebar renders on every route and highlights the section
//      the visitor is actually on (aria-current) — the quiet drift where a
//      page renders but the nav pretends you are somewhere else.
//   3. the Analytics tabs actually switch, and the two fixture-backed panels
//      (Artwork checks, Annotations) render tables and charts from their RPC
//      fixtures — a broken RPC-shape mapping fails here rather than on live.
//   4. the Settings jump nav lists exactly one link per on-page section,
//      clicking one scrolls that section under the sticky chrome, and the
//      #hash deep link the admin feature search relies on lands there too.
//   5. the Flagged and Feedback boards render their fixture cards, and their
//      filter affordances genuinely narrow the list rather than only
//      repainting their own pressed state.
//
// The mock backend is stateless — writes vanish — so nothing here asserts a
// post-refetch state change. ⚠ Assert STRUCTURE, never wording.

import { test, expect, type Page } from '@playwright/test'

const HARNESS = '/verify-harness/index.html?path='

// Collect console errors + uncaught page errors from before first paint.
// External resource failures are environmental (offline-by-design harness),
// so they are the one category filtered out — everything else, including the
// harness's own '[harness] uncaught render error' marker, fails the test.
//
// ⚠ One known fixture defect is allowlisted, by exact key: the shared
// mock-supabase ORDERS list carries TWO orders with id 'o13' (the on-hold one
// and the wide-row fulfilled one), so any page rendering both in one list —
// today only Admin → Shipping — fires React's duplicate-key warning. The
// fixture file is shared and off-limits to this spec; a duplicate of any
// OTHER key still fails. Remove this carve-out when the fixture id is fixed.
function collectErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    if (/Failed to load resource|net::ERR_|ERR_TUNNEL|ERR_PROXY|ERR_CONNECTION/i.test(text)) return
    if (text.includes('Encountered two children with the same key') && text.includes('o13')) return
    errors.push(text)
  })
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
  return errors
}

// ── 1+2. Every admin route mounts, with the sidebar oriented ────────────────
//
// One parameterised test per route. `active` is the sidebar link that must
// carry aria-current="page" there; null = the route is reachable but
// deliberately has no sidebar entry (Demo data), so nothing may light up.
const ADMIN_ROUTES: { path: string; active: string | null }[] = [
  { path: '/admin', active: '/admin' },
  { path: '/admin/catalogue/lead-times', active: '/admin/catalogue' },
  { path: '/admin/catalogue/card-weights', active: '/admin/catalogue' },
  { path: '/admin/catalogue/prototype-prices', active: '/admin/catalogue' },
  { path: '/admin/catalogue/xero-item-codes', active: '/admin/catalogue' },
  { path: '/admin/catalogue/material-options', active: '/admin/catalogue' },
  { path: '/admin/catalogue/paper-colours', active: '/admin/catalogue' },
  { path: '/admin/catalogue/stock-materials', active: '/admin/catalogue' },
  { path: '/admin/content/messages', active: '/admin/content' },
  { path: '/admin/content/site-copy', active: '/admin/content' },
  { path: '/admin/artwork-check', active: '/admin/artwork-check' },
  { path: '/admin/needs-attention', active: '/admin/needs-attention' },
  { path: '/admin/shipping', active: '/admin/shipping' },
  { path: '/admin/analytics', active: '/admin/analytics' },
  { path: '/admin/settings', active: '/admin/settings' },
  { path: '/admin/demo-data', active: null },
]

test.describe('every admin route mounts', () => {
  for (const route of ADMIN_ROUTES) {
    test(`${route.path} renders a heading, the grouped sidebar, and no render error`, async ({ page }) => {
      const errors = collectErrors(page)
      await page.goto(HARNESS + route.path)

      // The page mounted: some heading landmark rendered in the content area.
      // (Settings and the lazy catalogue tabs show a spinner first; the
      // auto-waiting expect rides that out.)
      await expect(page.locator('main').getByRole('heading').first()).toBeVisible()

      // The grouped sidebar: a nav of admin links under group headings.
      const sidebar = page.locator('aside nav')
      await expect(sidebar).toBeVisible()
      expect(await sidebar.locator('a[href^="/admin"]').count()).toBeGreaterThanOrEqual(10)
      expect(await sidebar.locator('div.eyebrow').count()).toBeGreaterThanOrEqual(3)

      // The sidebar knows where you are — or, for a deliberately unlisted
      // route, honestly claims nowhere.
      const active = sidebar.locator('a[aria-current="page"]')
      if (route.active) {
        await expect(active).toHaveCount(1)
        await expect(active).toHaveAttribute('href', route.active)
      } else {
        await expect(active).toHaveCount(0)
      }

      // Let lazily-loaded tab chunks land before reading the error log, so a
      // crash inside a lazy grid still fails this route's test.
      await page.waitForLoadState('networkidle')
      expect(errors).toEqual([])
    })
  }
})

// ── 3. Analytics tabs ───────────────────────────────────────────────────────
//
// The six tab buttons are the only direct button children of the underlined
// strip; everything below addresses tabs by ORDER, never by label.
const ANALYTICS_TABS = 'main div.border-b > button'

test.describe('analytics tabs', () => {
  test('all six tabs switch and each renders its own panel', async ({ page }) => {
    const errors = collectErrors(page)
    await page.goto(HARNESS + '/admin/analytics')
    const tabs = page.locator(ANALYTICS_TABS)
    await expect(tabs).toHaveCount(6)

    // Funnel (the default tab): its stacked panels render even though the
    // funnel RPCs resolve empty in the harness — the page must not need live
    // data to stay upright.
    expect(await page.locator('main section').count()).toBeGreaterThanOrEqual(2)

    // Hot leads: one panel carrying its tier-filter chip row.
    await tabs.nth(1).click()
    await expect(page.locator('main section')).toHaveCount(1)
    await expect(page.locator('main section button.rounded-full')).toHaveCount(5)

    // Team: the conversion table renders (empty body on these fixtures).
    await tabs.nth(2).click()
    await expect(page.locator('main section table')).toHaveCount(1)

    // Products: one panel per segment dimension.
    await tabs.nth(3).click()
    expect(await page.locator('main section').count()).toBeGreaterThanOrEqual(4)

    await page.waitForLoadState('networkidle')
    expect(errors).toEqual([])
  })

  test('Artwork checks renders its fixture-backed usage panels', async ({ page }) => {
    const errors = collectErrors(page)
    await page.goto(HARNESS + '/admin/analytics')
    const tabs = page.locator(ANALYTICS_TABS)
    await expect(tabs).toHaveCount(6)
    await tabs.nth(4).click()

    // The who-runs-it table is the first table on the tab and must carry one
    // row per fixture person with manual runs (4 in the RPC fixture). If the
    // RPC → table mapping drifts, this count is what breaks.
    await expect(page.locator('main table').first().locator('tbody tr')).toHaveCount(4)

    // The run-frequency chart renders (the only role="img" svg on this tab).
    const chart = page.locator('main svg[role="img"]')
    await expect(chart).toHaveCount(1)
    expect(errors).toEqual([])
  })

  test('the checks chart swaps between day and week grain', async ({ page }) => {
    await page.goto(HARNESS + '/admin/analytics')
    const tabs = page.locator(ANALYTICS_TABS)
    await expect(tabs).toHaveCount(6)
    await tabs.nth(4).click()

    // The grain toggle lives in the chart panel's own header: two buttons,
    // day first (the default), week second. The fixture has 30 daily rows and
    // 4 weekly ones, so the bar count must visibly collapse on Week and
    // return on Day — proof the toggle swaps the DATA, not just its own tint.
    const chartPanel = page
      .locator('main section')
      .filter({ has: page.locator('svg[role="img"]') })
    await expect(chartPanel).toHaveCount(1)
    const grain = chartPanel.locator('header button')
    await expect(grain).toHaveCount(2)

    const dayRects = await chartPanel.locator('svg[role="img"] rect').count()
    expect(dayRects).toBeGreaterThan(0)

    await grain.nth(1).click()
    await expect
      .poll(async () => chartPanel.locator('svg[role="img"] rect').count())
      .toBeLessThan(dayRects)

    await grain.nth(0).click()
    await expect
      .poll(async () => chartPanel.locator('svg[role="img"] rect').count())
      .toBe(dayRects)
  })

  test('Annotations renders its fixture-backed usage panels', async ({ page }) => {
    const errors = collectErrors(page)
    await page.goto(HARNESS + '/admin/analytics')
    const tabs = page.locator(ANALYTICS_TABS)
    await expect(tabs).toHaveCount(6)
    await tabs.nth(5).click()

    // One row per fixture designer in the who-writes-callouts table (3), and
    // the weekly chart draws.
    await expect(page.locator('main table').first().locator('tbody tr')).toHaveCount(3)
    await expect(page.locator('main svg[role="img"]')).toHaveCount(1)
    expect(errors).toEqual([])
  })
})

// ── 4. Settings jump nav ────────────────────────────────────────────────────

test.describe('settings jump nav', () => {
  test('lists one link per section and clicking one scrolls it under the sticky chrome', async ({ page }) => {
    const errors = collectErrors(page)
    await page.goto(HARNESS + '/admin/settings')

    // The jump nav is the only nav inside <main>. It must carry exactly one
    // button per on-page section — counted off the live DOM, so a section
    // added without a jump link (or vice versa) fails without pinning ids.
    const nav = page.locator('main nav')
    await expect(nav).toBeVisible()
    const sections = page.locator('main section[id]')
    const sectionCount = await sections.count()
    expect(sectionCount).toBeGreaterThanOrEqual(5)
    await expect(nav.locator('button')).toHaveCount(sectionCount)

    // Jump to the LAST section: it must land just under the sticky chrome
    // (its scroll-margin), the document must actually have scrolled, and the
    // sticky nav must still be on screen — that stickiness is the whole point
    // of the jump nav on a nine-section page.
    await nav.locator('button').last().click()
    const target = sections.last()
    await expect(async () => {
      const box = await target.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.y).toBeGreaterThanOrEqual(0)
      expect(box!.y).toBeLessThanOrEqual(300)
    }).toPass()
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
    await expect(nav).toBeInViewport()
    expect(errors).toEqual([])
  })

  test('a #hash deep link lands on its section', async ({ page }) => {
    // The admin feature search reaches individual Settings sections via
    // /admin/settings#<id>. Read the last section's id off the live DOM so
    // this follows the section registry instead of pinning an id.
    await page.goto(HARNESS + '/admin/settings')
    const sections = page.locator('main section[id]')
    await expect(sections.first()).toBeVisible()
    const id = await sections.last().getAttribute('id')
    expect(id).toBeTruthy()

    await page.goto(`${HARNESS}/admin/settings%23${id}`)
    const target = page.locator(`main section[id="${id}"]`)
    await expect(target).toBeVisible()
    await expect(async () => {
      const box = await target.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.y).toBeGreaterThanOrEqual(-50)
      expect(box!.y).toBeLessThanOrEqual(300)
    }).toPass()
  })
})

// ── 5a. Flagged board ───────────────────────────────────────────────────────
//
// Two fixture watch-items: one open (Acme / quality complaint, 3 updates),
// one monitoring (Vandelay / lost in transit). A card is the only
// button[aria-expanded] inside <main> on this page.

const FLAG_CARD = 'main button[aria-expanded]'

test.describe('flagged board', () => {
  test('renders both fixture cards collapsed, without a render error', async ({ page }) => {
    const errors = collectErrors(page)
    await page.goto(HARNESS + '/flagged')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    const cards = page.locator(FLAG_CARD)
    await expect(cards).toHaveCount(2)
    for (let i = 0; i < 2; i++) {
      await expect(cards.nth(i)).toHaveAttribute('aria-expanded', 'false')
    }
    await page.waitForLoadState('networkidle')
    expect(errors).toEqual([])
  })

  test('scope chips narrow the board and the empty scope explains itself', async ({ page }) => {
    await page.goto(HARNESS + '/flagged')
    const cards = page.locator(FLAG_CARD)
    await expect(cards).toHaveCount(2)

    // Both fixtures are unresolved, so the Resolved scope must go empty — and
    // say so with the dashed empty state rather than a blank page.
    await page.getByRole('button', { name: /resolved/i }).click()
    await expect(cards).toHaveCount(0)
    await expect(page.locator('main div.border-dashed')).toBeVisible()

    await page.getByRole('button', { name: /^all/i }).click()
    await expect(cards).toHaveCount(2)
  })

  test('the header search narrows to the matching card and clearing restores', async ({ page }) => {
    await page.goto(HARNESS + '/flagged')
    const cards = page.locator(FLAG_CARD)
    await expect(cards).toHaveCount(2)

    // Matches the second fixture's company only.
    await page.getByRole('searchbox').fill('vandelay')
    await expect(cards).toHaveCount(1)

    await page.getByRole('searchbox').fill('')
    await expect(cards).toHaveCount(2)
  })

  test('expanding a card reveals its update thread and composer', async ({ page }) => {
    await page.goto(HARNESS + '/flagged')
    const cards = page.locator(FLAG_CARD)
    await expect(cards).toHaveCount(2)

    // Default sort is by status, so the first card is the open item — the one
    // with three fixture updates behind it.
    await cards.first().click()
    await expect(cards.first()).toHaveAttribute('aria-expanded', 'true')

    // The update-type picker is a real radiogroup with the two manual kinds;
    // the composer's send button stays disabled until something is typed.
    const radios = page.getByRole('radio')
    await expect(radios).toHaveCount(2)
    await expect(radios.first()).toHaveAttribute('aria-checked', 'true')
    const composer = page.locator('main textarea')
    await expect(composer).toBeVisible()
  })
})

// ── 5b. Feedback board ──────────────────────────────────────────────────────
//
// Seven fixture items, all in the Open lifecycle (statuses new/under_review):
// one by another user (fb-1, low priority), four high, two medium. On load
// the section headers are expanded (aria-expanded=true) and every card is
// collapsed, so button[aria-expanded="false"] counts exactly the cards.

const FEEDBACK_CARD = 'main button[aria-expanded="false"]'

test.describe('feedback board', () => {
  test('renders every fixture card under the default open scope', async ({ page }) => {
    const errors = collectErrors(page)
    await page.goto(HARNESS + '/feedback')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.locator(FEEDBACK_CARD)).toHaveCount(7)

    // The scope pills + the Mine toggle are the four aria-pressed controls,
    // and exactly one scope is pressed at a time.
    const pressed = page.locator('main button[aria-pressed="true"]')
    await expect(pressed).toHaveCount(1)
    await page.waitForLoadState('networkidle')
    expect(errors).toEqual([])
  })

  test('the priority dropdown narrows the board and back', async ({ page }) => {
    await page.goto(HARNESS + '/feedback')
    const cards = page.locator(FEEDBACK_CARD)
    await expect(cards).toHaveCount(7)

    // The three secondary dropdowns render in order Sort · Type · Priority;
    // option values are enum codes, not display copy.
    const priority = page.locator('main select').nth(2)
    await priority.selectOption('high')
    await expect(cards).toHaveCount(4)
    await priority.selectOption('all')
    await expect(cards).toHaveCount(7)
  })

  test('the Mine toggle keeps only the signed-in user\'s cards', async ({ page }) => {
    await page.goto(HARNESS + '/feedback')
    const cards = page.locator(FEEDBACK_CARD)
    await expect(cards).toHaveCount(7)

    // Mine is the fourth aria-pressed control (after the three scope pills).
    // One fixture belongs to a colleague, so the count must drop by exactly
    // one — proof the filter reads authorship, not just its own tint.
    const mine = page.locator('main button[aria-pressed]').nth(3)
    await mine.click()
    await expect(mine).toHaveAttribute('aria-pressed', 'true')
    await expect(cards).toHaveCount(6)

    await mine.click()
    await expect(cards).toHaveCount(7)
  })

  test('the resolved scope goes empty honestly', async ({ page }) => {
    await page.goto(HARNESS + '/feedback')
    const cards = page.locator(FEEDBACK_CARD)
    await expect(cards).toHaveCount(7)

    // No fixture is resolved, so the third scope pill must empty the board
    // into the explanatory empty state, and the pressed state must move.
    const scopes = page.locator('main button[aria-pressed]')
    await scopes.nth(2).click()
    await expect(scopes.nth(2)).toHaveAttribute('aria-pressed', 'true')
    await expect(scopes.nth(0)).toHaveAttribute('aria-pressed', 'false')
    await expect(cards).toHaveCount(0)
    await expect(page.locator('main div.border-dashed')).toBeVisible()
  })

  test('expanding a card reveals its body', async ({ page }) => {
    await page.goto(HARNESS + '/feedback')
    const cards = page.locator(FEEDBACK_CARD)
    await expect(cards).toHaveCount(7)

    // The first card in the smart sort is the under_review fixture, which
    // carries a body paragraph; expanding must flip aria-expanded and render
    // the body region.
    const first = cards.first()
    await first.click()
    await expect(page.locator('main button[aria-expanded="true"]').first()).toBeVisible()
    await expect(page.locator('main p.whitespace-pre-wrap').first()).toBeVisible()
  })
})
