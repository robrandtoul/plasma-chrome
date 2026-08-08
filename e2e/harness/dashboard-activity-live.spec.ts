// The dashboard's Latest activity card, fed live.
//
// The card is six sources merged on the client, not a table, so it's kept fresh
// in two halves: page views arrive over realtime and fold into the feed by
// hand, everything else is re-fetched on a timer. That hand-written fold is
// where the risk sits, because it has to reach the same answer the polled
// rebuild would — anything the two disagree about shows up as a row that
// appears and then changes or vanishes seconds later, with nobody having
// touched anything, which reads as broken data rather than a broken merge.
//
// What these lock in, and the real failure each exists to catch:
//
//   1. a view that arrives live is added AND named. The socket delivers a bare
//      proof_version_views row; the card needs the company, contact and version
//      number that the database view gets from its joins. A row that landed
//      unenriched would read "Customer opened v0".
//   2. a customer refreshing their proof five times is ONE line whose clock
//      moves, not five lines. dashboard_latest_events keeps one row per version
//      per day (000242) and the live path has to keep the same one.
//   3. a bot never reaches the card. The view filters bots in SQL, so a bot row
//      shown live would be silently taken away again by the next poll.
//   4. the feed holds its cap when a live row arrives, so the card can't grow
//      past the length a rebuild would give it.
//   5. a new row is briefly highlighted and then isn't. Without the highlight
//      the card updates silently and a row you never saw arrive is
//      indistinguishable from one that was always there — which is most of the
//      point of making it live. Without the fade, the whole feed ends the day
//      tinted.
//
// The realtime delivery itself is faked: the harness has no socket, so
// window.__pvRealtime.emit() hands a row to the handler the page really
// registered, through the page's real code. emit() returns how many handlers
// took it, so a test can't pass because nothing was listening.
//
// ⚠ Assert STRUCTURE and FIXTURE DATA, never UI wording.

import { test, expect, type Page } from '@playwright/test'

// Feed rows are the only li[role="button"] on this page — project rows are
// div[role="button"] — so this needs no dependence on the panel's heading.
const FEED_ROW = 'li[role="button"]'

// Fixture proofs, by the version id a view would carry:
//   ver-b1 → Atlus Consulting Engineers / Saba, current version 1
//   ver-x1 → Leccy.Tech / Laurence Phillips, current version 2
const ATLAS_VERSION = 'ver-b1'
const ATLAS_COMPANY = 'Atlus Consulting Engineers'
const ATLAS_CONTACT = 'Saba'
const LECCY_VERSION = 'ver-x1'

async function openDashboard(page: Page) {
  await page.goto('/verify-harness/index.html?path=/dashboard')
  // The feed is populated by the page's initial load; wait for it rather than
  // for a fixed delay, so a slow first paint can't race the emit below.
  await expect(page.locator(FEED_ROW).first()).toBeVisible()
}

// Deliver one proof_version_views row exactly as the socket would, and fail
// loudly if the page had no handler registered for it.
async function emitView(
  page: Page,
  row: { id: string; proof_version_id: string; viewed_at: string; is_bot?: boolean },
) {
  const delivered = await page.evaluate(
    (r) =>
      (window as unknown as { __pvRealtime: { emit: (t: string, row: unknown) => number } })
        .__pvRealtime.emit('proof_version_views', { is_bot: false, ...r }),
    row,
  )
  expect(delivered, 'the page must have a live subscription for this to mean anything').toBeGreaterThan(0)
}

test.describe('Latest activity — live page views', () => {
  test('a view that arrives live is added to the top, carrying who it was', async ({ page }) => {
    await openDashboard(page)
    const before = await page.locator(FEED_ROW).count()

    await emitView(page, {
      id: 'live-1',
      proof_version_id: ATLAS_VERSION,
      viewed_at: new Date().toISOString(),
    })

    // Newest first, so the live row is the one at the top — anywhere else and
    // it would be buried under a fortnight of history.
    const top = page.locator(FEED_ROW).first()
    // Company AND contact: both come from the loaded projects, not from the
    // realtime payload, so together they prove the enrichment ran.
    await expect(top).toContainText(ATLAS_COMPANY)
    await expect(top).toContainText(ATLAS_CONTACT)
    expect(before, 'the fixture feed must not be empty for this to mean anything').toBeGreaterThan(0)
  })

  test('a customer refreshing is one row, not one row per refresh', async ({ page }) => {
    await openDashboard(page)
    // Counted per customer, not across the whole feed: the fixture fills the
    // card to its cap, so every added row evicts the oldest and the total is
    // the same whether one row arrived or three. Only this count can tell the
    // dedup working from the dedup missing.
    const atlas = page.locator(FEED_ROW).filter({ hasText: ATLAS_COMPANY })
    const before = await atlas.count()

    // Three views of the same version, minutes apart on the same day.
    const base = Date.now()
    for (let i = 0; i < 3; i++) {
      await emitView(page, {
        id: `repeat-${i}`,
        proof_version_id: ATLAS_VERSION,
        viewed_at: new Date(base + i * 60_000).toISOString(),
      })
    }

    // One row was added for the first view; the second and third moved it.
    await expect(atlas).toHaveCount(before + 1)
    await expect(page.locator(FEED_ROW).first()).toContainText(ATLAS_COMPANY)
  })

  test('a bot view never reaches the card', async ({ page }) => {
    await openDashboard(page)
    const before = await page.locator(FEED_ROW).count()

    await emitView(page, {
      id: 'bot-1',
      proof_version_id: LECCY_VERSION,
      viewed_at: new Date().toISOString(),
      is_bot: true,
    })

    await expect(page.locator(FEED_ROW)).toHaveCount(before)
  })

  test('the feed holds its cap when a live row arrives', async ({ page }) => {
    await openDashboard(page)
    const before = await page.locator(FEED_ROW).count()

    // The fixture fills the card to its cap, so an added row must evict one.
    // Guard the premise: if the fixture ever shrinks below the cap this test
    // would silently stop testing anything.
    expect(before, 'fixture must fill the feed for the cap to be exercised').toBeGreaterThanOrEqual(20)

    await emitView(page, {
      id: 'cap-1',
      proof_version_id: ATLAS_VERSION,
      viewed_at: new Date().toISOString(),
    })

    await expect(page.locator(FEED_ROW)).toHaveCount(before)
  })

  test('a new row is highlighted, and stops being highlighted', async ({ page }) => {
    await openDashboard(page)
    // Compare against a neighbour rather than pinning a colour, so a restyle
    // doesn't fail this and a lost highlight still does.
    const styleOf = (n: number) => page.locator(FEED_ROW).nth(n).getAttribute('style')

    await emitView(page, {
      id: 'fresh-1',
      proof_version_id: ATLAS_VERSION,
      viewed_at: new Date().toISOString(),
    })

    expect(await styleOf(0), 'the row that just arrived carries a background the others do not').toContain('background-color')
    expect(await styleOf(1) ?? '').not.toContain('background-color')

    // Auto-waiting, not a fixed sleep: the highlight is dropped a few seconds
    // after it lands and the transition fades it out.
    await expect(page.locator(FEED_ROW).first()).not.toHaveAttribute('style', /background-color/, { timeout: 15_000 })
  })
})
