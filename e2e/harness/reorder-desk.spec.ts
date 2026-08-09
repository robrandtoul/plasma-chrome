// The Reorder desk panel (migration 000389), on its standalone rig:
//
//   ?path=/reorder-desk — ReorderDeskPanel at the dashboard rail's width,
//   against the reorder-desk fixture module (verify-harness/fixtures/
//   reorder-desk.ts, ids rd-…), one prospect per bucket.
//
// The desk is the one dashboard surface whose whole day is computed
// client-side from one load (planDesk), so a fixture/claim break or a bucket
// predicate regression doesn't error — it silently serves the wrong people.
// The real failures these specs exist to catch:
//
//   1. the buckets collapsing into each other (a contacted row surfacing under
//      Today, or a follow-up and a quiet close swapping) — the difference
//      between them is ONE non-bot view row, and getting it backwards emails
//      a customer who never opened the page while ghosting one who did.
//   2. the day's queue losing its score order, or the promotion path dying so
//      the pending pool never surfaces at all.
//   3. a desk action (skip) breaking the panel — the mock drops writes, so the
//      reload after an action must re-serve the same plan, not an error state.
//   4. the follow-up action losing its compose step — that dialog is the ONE
//      personal note an opened-but-quiet customer gets, and it must arrive
//      with an editable body (template row absent here on purpose, so this
//      also exercises the DEFAULT_BODIES fallback).
//   5. the quiet close growing an email affordance — silence is the designed
//      answer for a customer who never opened the page.
//
// ⚠ Assert STRUCTURE, never wording: section/list/button counts, DOM order,
// dialog presence. Names asserted below are fixture data, not copy.

import { test, expect, type Page } from '@playwright/test'

function collectHarnessErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' && m.text().includes('[harness] uncaught render error')) {
      errors.push(m.text())
    }
  })
  return errors
}

test.describe('reorder desk (?path=/reorder-desk)', () => {
  test.beforeEach(async ({ page }) => {
    // The harness lives at /verify-harness/index.html — "/" on this port is
    // the real app against a dead backend, a trap that has cost time before.
    await page.goto('/verify-harness/index.html?path=/reorder-desk')
    // Loaded = the four bucket sections are on screen (nested inside the
    // panel's own <section> shell).
    await expect(page.locator('section section')).toHaveCount(4)
  })

  test('renders the four buckets from one load, expanded, with no render errors', async ({ page }) => {
    const errors = collectHarnessErrors(page)

    // One panel shell: a single level-2 heading whose disclosure button is
    // expanded (the buckets render inside it).
    await expect(page.getByRole('heading', { level: 2 })).toHaveCount(1)
    await expect(page.locator('h2 button')).toHaveAttribute('aria-expanded', 'true')

    // Four buckets, each with its own level-3 heading, in the panel's fixed
    // order: Today, In build, follow-ups, no-response.
    const sections = page.locator('section section')
    await expect(page.getByRole('heading', { level: 3 })).toHaveCount(4)

    // Today: two served this morning + one promoted from pending = 3 rows,
    // each carrying the full action set (start / rest / never = 3 buttons).
    const today = sections.nth(0)
    await expect(today.locator('li')).toHaveCount(3)
    for (const i of [0, 1, 2]) {
      await expect(today.locator('li').nth(i).getByRole('button')).toHaveCount(3)
    }

    // In build: one project, three actions (open it / record an outside-the-
    // app send so the follow-up clock starts / put it back).
    const inBuild = sections.nth(1)
    await expect(inBuild.locator('li')).toHaveCount(1)
    await expect(inBuild.locator('li').getByRole('button')).toHaveCount(3)

    // Follow-ups: one opened-but-quiet customer, one action.
    const followUps = sections.nth(2)
    await expect(followUps.locator('li')).toHaveCount(1)
    await expect(followUps.locator('li').getByRole('button')).toHaveCount(1)

    // No response: one never-opened customer, one action — and only one:
    // no compose affordance exists on this row (see the dialog test below).
    const quiet = sections.nth(3)
    await expect(quiet.locator('li')).toHaveCount(1)
    await expect(quiet.locator('li').getByRole('button')).toHaveCount(1)

    expect(errors).toEqual([])
  })

  test('the day’s queue is served best score first, promotion included', async ({ page }) => {
    // Fixture data, not copy: the pending prospect (score 90) must be
    // PROMOTED into today's queue and outrank both already-served rows
    // (80, 70). If the promotion path dies, Jacquard never appears; if the
    // sort regresses, it appears last.
    const today = page.locator('section section').nth(0)
    await expect(today.locator('li').nth(0)).toContainText('Jacquard')
    await expect(today.locator('li').nth(1)).toContainText('Analytical')
    await expect(today.locator('li').nth(2)).toContainText('Difference')
  })

  test('a skip action survives the stateless mock: the desk reloads the same plan, no error state', async ({ page }) => {
    const errors = collectHarnessErrors(page)
    const today = page.locator('section section').nth(0)

    // The middle button on a Today row is the rest-for-90-days skip. The mock
    // accepts and drops the write, then the panel refetches — so the SAME
    // plan must come back: still four buckets, still three Today rows, the
    // action live again once the busy state clears. What this catches is the
    // action path dying (an error would replace the whole body with a single
    // message paragraph, collapsing the section count).
    await today.locator('li').nth(0).getByRole('button').nth(1).click()
    await expect(page.locator('section section')).toHaveCount(4)
    await expect(today.locator('li')).toHaveCount(3)
    await expect(today.locator('li').nth(0).getByRole('button').nth(1)).toBeEnabled()

    expect(errors).toEqual([])
  })

  test('the follow-up action opens a compose dialog with an editable, non-empty body', async ({ page }) => {
    const errors = collectHarnessErrors(page)

    // The follow-ups bucket's single action opens the send modal. Its body
    // must arrive editable and non-empty: no reply_templates fixture exists
    // on purpose, so the panel is proving the DEFAULT_BODIES fallback renders
    // a real message (wording deliberately not asserted).
    await page.locator('section section').nth(2).getByRole('button').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('textarea')).toHaveCount(1)
    await expect(dialog.locator('textarea')).toHaveValue(/\S/)

    expect(errors).toEqual([])
  })

  test('the quiet close acts without composing anything — no dialog, desk intact', async ({ page }) => {
    const errors = collectHarnessErrors(page)

    // Closing a never-opened prospect is deliberately silent: the click must
    // not open any compose surface, and the desk must come back whole after
    // the (dropped) write + reload.
    await page.locator('section section').nth(3).getByRole('button').click()
    await expect(page.locator('section section')).toHaveCount(4)
    await expect(page.getByRole('dialog')).toHaveCount(0)

    expect(errors).toEqual([])
  })
})
