// The dashboard's right rail against the search box (?path=/dashboard).
//
// THE FAILURE THIS EXISTS TO CATCH. dashboard_list(p_search) returns the
// working set for an empty term and ONLY the matches for a non-empty one — it
// is not a superset. The page held that one result in `projects` and handed the
// same array to the sidebar cards, which have no names of their own: the Outbox
// turns a proof_id into "Sweet Beats" by looking the proof up in it, and Latest
// activity both names its rows and derives the Help Scout reply rows outright
// from it. So the moment anyone typed in the search box, every Outbox line
// collapsed to "Proof 2b1d5918…" and the activity card silently dropped every
// row belonging to a project the search didn't match. It reached live, and was
// only noticed because the Outbox suddenly read as a list of ids.
//
// The rail describes the whole desk; only the list obeys the search. These
// tests pin that: what the rail says must not depend on what is in the box.
//
// Both tests land directly on ?q=… so the FIRST load is the searched one. That
// is deliberate, and the only way to assert this without a sleep: typing into
// the box narrows the list client-side instantly but re-fetches 300ms later, so
// a spec that types and then asserts reads the page BEFORE the fetch that
// breaks it, and passes on broken code — which is what the first draft of this
// file did. The URL is the same code path with the debounce taken out (both end
// in loadDashboard() with a non-empty term), and it is a path designers really
// use: the term lives in the query string so a filtered view can be bookmarked
// and survives opening a proof and coming back. Typing itself is already
// covered by dashboard.spec.
//
// ⚠ Assert STRUCTURE, never wording. The company names below are fixture DATA
// arriving through a client-side join, not page copy.

import { test, expect, type Page } from '@playwright/test'

// A project row is the only div[role="button"] on the page (activity rows are
// li[role="button"], so the two can never collide).
const ROW = 'div[role="button"]'

// Every Outbox line is either a <summary> (a sent reminder, which expands to
// show the rendered body) or a link to the proof (the skip rows).
const OUTBOX_LINE = 'summary, a[href^="/proofs/"]'

// The two rail cards, located by their heading — a locator, not an assertion.
function outbox(page: Page) {
  return page.locator('section').filter({ hasText: /Automated reminders/i })
}
function activity(page: Page) {
  return page.locator('section').filter({ hasText: /Latest activity/i })
}

// The Outbox's fallback when a proof isn't in the array it was handed —
// `Proof ${id.slice(0, 8)}…`. Its presence IS the bug.
const ID_FALLBACK = /Proof p-/

// Three fixture proofs carry ledger rows in the latest run, one per Outbox
// section (a send, a skip needing a human, a self-clearing hold). None matches
// the search term, so under the bug all three lose their names.
const OUTBOX_NAMES = ['Leccy.Tech', 'Sweet Beats', 'Harbour & Moss']

// Matches exactly one of the eight fixture projects, and none of the proofs the
// rail is reporting on.
const TERM = 'vandelay'

async function openDashboard(page: Page, query = '') {
  // The harness lives at /verify-harness/index.html — "/" on this port is the
  // real app against a dead backend, a trap that has cost time before.
  await page.goto(`/verify-harness/index.html?path=/dashboard${query}`)
}

test.describe('the rail survives a search', () => {
  test('a searched load still names every Outbox row', async ({ page }) => {
    await openDashboard(page, `&q=${TERM}`)
    // The search really is in force: one of eight projects left.
    await expect(page.locator(ROW)).toHaveCount(1)

    const lines = outbox(page).locator(OUTBOX_LINE)
    for (const name of OUTBOX_NAMES) {
      await expect(lines.filter({ hasText: name })).toHaveCount(1)
    }
    await expect(outbox(page)).not.toContainText(ID_FALLBACK)
  })

  test('a searched load keeps the activity rows the search excludes', async ({ page }) => {
    // Counting rows would prove nothing — the feed caps at 20 and the fixture
    // set overflows it, so rows can drop out and the count still reads 20. What
    // actually disappeared was every row belonging to a non-matching project,
    // so assert one of those by name. Its Help Scout reply row is derived from
    // the projects array outright, not merely labelled from it, so under the
    // bug there is nothing to render at all.
    await openDashboard(page)
    const rows = activity(page).locator('li')
    await expect(rows.filter({ hasText: 'Leccy.Tech' }).first()).toBeVisible()

    await openDashboard(page, `&q=${TERM}`)
    await expect(page.locator(ROW)).toHaveCount(1)
    await expect(rows.filter({ hasText: 'Leccy.Tech' }).first()).toBeVisible()
  })
})
