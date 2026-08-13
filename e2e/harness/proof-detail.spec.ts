// The designer's proof page (/proofs/:id) and its destructive-action guards.
//
// Runs against the verify harness: /proofs/p-open mounts the in-progress
// fixture project and /proofs/p-a1 the approved one (mock-supabase branches on
// the id containing 'open'). The change-request strip and customer pins on
// /proofs/p-open-changes are already covered by e2e/designer/customer-pins.spec.ts
// and are deliberately not touched here.
//
// What these lock in, and the real failures each exists to catch:
//
//   1. the action set follows the proof's status. An OPEN proof offers Abandon
//      and Mark-as-approved and must NOT offer Reopen; an APPROVED one offers
//      Reopen and must NOT offer Abandon. Reopen deletes every approval row on
//      the proof (reopen_proof, migration 000158), so offering it on the wrong
//      state — or losing Abandon behind a regression — hands a designer the
//      wrong destructive tool with one click.
//   2. "Add a new version" on an APPROVED proof goes through an explainer
//      dialog, never straight to the form. The explainer is the whole gate
//      between the approval-keeping path and the approval-wiping Reopen one
//      click away; both entrances (header button and Versions-panel button)
//      must hit it, because a second ungated entrance is exactly the bug shape
//      this feature shipped to close.
//   3. Duplicate project confirms before doing anything, and cancelling
//      really is a no-op.
//   4. the customer link stays copyable and points at this proof's own /p/
//      page — it is the one thing a designer pastes into replies all day.
//   5. the approved treatment is visibly different from the open one (left
//      status cap + version-row state pill), compared across the two fixtures
//      rather than pinned to hex values so a palette change doesn't fail it.
//
// ⚠ Assert STRUCTURE, never wording. Menu items are matched on their action
// verb (abandon / reopen / duplicate), which IS the semantics under test.

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

async function openOverflowMenu(page: Page) {
  await page.getByRole('button', { name: 'More actions' }).click()
  await expect(page.getByRole('menu')).toBeVisible()
}

test.describe('the open project (p-open)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/verify-harness/index.html?path=/proofs/p-open')
    // The fixture contact's company — same landmark customer-pins.spec uses.
    await expect(page.getByRole('heading', { name: /realise/i })).toBeVisible()
  })

  test('renders clean with a status pill and its single current version listed', async ({ page }) => {
    const errors = collectHarnessErrors(page)

    // The header card carries a status pill (bucket-driven label, so we assert
    // presence, not text — the treatment test below proves it is state-driven).
    const header = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { level: 1 }) })
      .first()
    await expect(header.locator('.pill').first()).toBeVisible()

    // Exactly one version row, reachable by its accessible name, carrying its
    // own state pill. The fixture pins one current v1; a second row or a
    // missing pill means the versions list broke.
    const rows = page.locator('li[role="button"]')
    await expect(rows).toHaveCount(1)
    // exact: the hero card has its own "Open version 1 detail" button.
    await expect(page.getByRole('button', { name: 'Open version 1', exact: true })).toBeVisible()
    await expect(rows.first().locator('.pill').first()).toBeVisible()

    expect(errors).toEqual([])
  })

  test('offers Abandon and Mark-as-approved, and never Reopen', async ({ page }) => {
    // The destructive set for an open proof. Reopen appearing here would offer
    // an approval-wiping action on a proof that has no approvals to wipe — and
    // Abandon disappearing strands the designer with no way to close a dead lead.
    await openOverflowMenu(page)
    await expect(page.getByRole('menuitem', { name: /abandon/i })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /approve/i })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /reopen/i })).toHaveCount(0)
  })

  test('everyday actions are add-version and preview — no order path yet', async ({ page }) => {
    // An open proof cannot take an order (create-order requires approval), so
    // the order button must not render; the add-version primary and the
    // customer-view preview must.
    await expect(page.getByRole('button', { name: /add a new version/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /open customer view/i })).toBeEnabled()
    await expect(page.getByRole('button', { name: /create order/i })).toHaveCount(0)
  })
})

test.describe('the approved project (p-a1)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/verify-harness/index.html?path=/proofs/p-a1')
    await expect(page.getByRole('heading', { name: /realise/i })).toBeVisible()
  })

  test('swaps the destructive guard: Reopen present, Abandon gone', async ({ page }) => {
    // The mirror of the open-proof test. An approved proof is locked; the only
    // way back is the order-aware Reopen. Abandon or Mark-as-approved leaking
    // in here would let a designer act on a state the action no longer fits.
    await openOverflowMenu(page)
    await expect(page.getByRole('menuitem', { name: /reopen/i })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /abandon/i })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: /approve/i })).toHaveCount(0)
  })

  test('gains the order path once approved', async ({ page }) => {
    // Create order is the approved proof's primary action (the fixture has no
    // existing order and the settings fixture has ordering enabled). Losing it
    // means the whole checkout flow has no front door from the proof page.
    await expect(page.getByRole('button', { name: /create order/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /open customer view/i })).toBeEnabled()
  })

  test('Duplicate project asks first, and cancelling walks away clean', async ({ page }) => {
    await openOverflowMenu(page)
    await page.getByRole('menuitem', { name: /duplicate/i }).click()

    // A confirm dialog, not an immediate copy: the dialog carries its own
    // confirm action plus a cancel.
    const dialog = page.getByRole('dialog', { name: /duplicate/i })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: /duplicate/i })).toBeEnabled()

    await dialog.getByRole('button', { name: /cancel/i }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Nothing happened: still one version, and the menu still offers the same
    // action (a stateless cancel leaves the page exactly as it was).
    await expect(page.locator('li[role="button"]')).toHaveCount(1)
    await openOverflowMenu(page)
    await expect(page.getByRole('menuitem', { name: /duplicate/i })).toBeVisible()
  })

  test('Add a new version gates through the explainer instead of navigating', async ({ page }) => {
    // On an approved proof this button must open the keep-the-approvals
    // explainer, never the form directly — the dialog is the only thing
    // distinguishing this path from the approval-wiping Reopen next to it.
    await page.getByRole('button', { name: /add a new version/i }).click()

    const dialog = page.getByRole('dialog', { name: /add a new version/i })
    await expect(dialog).toBeVisible()
    // Still on the detail page behind the modal — no navigation happened.
    await expect(page.getByRole('heading', { name: /realise/i })).toBeVisible()

    // Cancelling backs out entirely.
    await dialog.getByRole('button', { name: /cancel/i }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: /realise/i })).toBeVisible()

    // The Versions panel's own button is a second entrance to the same gate.
    // An ungated second entrance is precisely the regression this dialog
    // exists to prevent.
    await page.getByRole('button', { name: /new version/i }).last().click()
    await expect(page.getByRole('dialog', { name: /add a new version/i })).toBeVisible()
  })

  test('the customer URL is shown for this proof and copyable', async ({ page }) => {
    // The copy affordance is used constantly (pasting the link into replies).
    // The readout must point at THIS proof's /p/ page — a wrong id here means
    // designers copy a link to somebody else's proof.
    await expect(page.getByRole('button', { name: /copy customer url/i })).toBeVisible()
    await expect(page.getByText('/p/p-a1')).toBeVisible()
  })
})

test.describe('approved vs open treatment', () => {
  test('the page treatment tracks the proof status', async ({ page }) => {
    // Compared across the two fixtures rather than against pinned colours, so
    // a palette change cannot fail this — only the two states collapsing into
    // one treatment can. That collapse is the real failure: a designer telling
    // approved from in-progress at a glance is what the left cap and the
    // version-row pill are for.
    const capColour = () =>
      page
        .locator('section')
        .filter({ has: page.getByRole('heading', { level: 1 }) })
        .first()
        .evaluate((el) => getComputedStyle(el).borderLeftColor)
    const rowPillColour = () =>
      page
        .locator('li[role="button"]')
        .first()
        .locator('.pill')
        .first()
        .evaluate((el) => getComputedStyle(el).color)

    await page.goto('/verify-harness/index.html?path=/proofs/p-open')
    await expect(page.getByRole('heading', { name: /realise/i })).toBeVisible()
    await expect(page.locator('li[role="button"]').first().locator('.pill').first()).toBeVisible()
    const openCap = await capColour()
    const openPill = await rowPillColour()

    await page.goto('/verify-harness/index.html?path=/proofs/p-a1')
    await expect(page.getByRole('heading', { name: /realise/i })).toBeVisible()
    await expect(page.locator('li[role="button"]').first().locator('.pill').first()).toBeVisible()
    const approvedCap = await capColour()
    const approvedPill = await rowPillColour()

    expect(approvedCap).not.toBe(openCap)
    expect(approvedPill).not.toBe(openPill)
  })
})

test.describe('the ordered project (p-ordered)', () => {
  // The project page carries TWO different artwork checks, and they are easy
  // to confuse: the pre-send "Proof check" runs against the proof images
  // before the customer sees them, while the order's check runs against the
  // PRINT FILES at placement and is the one that gates going to production.
  //
  // Only the first was ever reachable from here. So a designer coming back to
  // ask "what did the check say?" found the proof-check panel offering to run
  // one, and reasonably concluded no check had ever happened — while the
  // order's stored report sat one table away (order 403980, Aug 2026, whose
  // print files had lost the cut-throughs the proof showed).
  //
  // The fixture reproduces that exact pairing: a placed order with a stored
  // report, on a proof version whose own pre-send check is null.
  //
  // ⚠ SCOPE — the render path, not the fetch: the harness mock ignores select
  // strings and returns whole rows, so removing artwork_check_verdict from the
  // orders select would still pass here. See orders-log.spec.ts.
  test.beforeEach(async ({ page }) => {
    await page.goto('/verify-harness/index.html?path=/proofs/p-ordered')
    await expect(page.getByRole('heading', { name: /realise/i })).toBeVisible()
  })

  test('the order strip offers the order-time artwork check', async ({ page }) => {
    // The pre-send panel still says the proof check has never run — which is
    // true, and is exactly the state that used to read as "no report exists".
    await expect(page.getByRole('button', { name: /run check/i })).toBeVisible()

    // …and the order's own check is nonetheless reachable, right beside the
    // order status it belongs to.
    await expect(page.getByRole('button', { name: /artwork check/i })).toBeVisible()
  })

  test('it opens the stored report, distinct from the pre-send proof check', async ({ page }) => {
    await page.getByRole('button', { name: /artwork check/i }).click()

    const report = page.getByRole('dialog')
    await expect(report).toBeVisible()
    // Fixture field values rather than UI copy — a rewording must not fail it.
    await expect(report.getByText('richard@piedpiper.com').first()).toBeVisible()

    // Read-only by exhaustion: Close is the only control. The acting surfaces
    // are the Orders page and the Place-order review screen; this order is
    // already in production.
    await expect(report.getByRole('button')).toHaveCount(1)
    await report.getByRole('button', { name: /close/i }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
})
