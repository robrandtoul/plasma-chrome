// Advisory tick-off ("Mark as addressed") on the artwork-check report —
// exercised on the place-order review rig (?path=/orders/o1/place), whose
// fixture report carries exactly two advisories: one defect-grade email flag
// and one unresolved customer correction.
//
// The real failures these specs exist to catch:
//
//   1. the per-item tick disappearing, or collapsing into one clear-the-lot
//      control — one tick per advisory is the design (a single button is
//      exactly the thing that gets pressed unread), so each advisory must
//      offer its own control and its own reason picker.
//   2. a tick not landing: the server returns the updated report and the page
//      must swap it in without a refetch — a dropped write here shows the
//      designer a tick that silently never persisted, the exact silent-write
//      class the e2e suite exists for.
//   3. Undo disappearing — a tick must be reversible, or a slip of the mouse
//      permanently (and attributively) signs off an advisory.
//   4. the reason picker committing without a reason — picking the reason IS
//      the tick; a bare tick would gut the record (and the allow-list tuning
//      data) the feature exists to create.
//
// The mock accumulates ticks per page load (artworkAckStore), so the full
// worklist flow — tick, tick, everything addressed, undo — runs end to end.
//
// ⚠ Assert STRUCTURE, never wording: counts of role-named controls, presence
// and absence, before/after — no headline text, no reason-label prose.

import { test, expect } from '@playwright/test'

test.describe('artwork-check advisory tick-off (o1)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/verify-harness/index.html?path=/orders/o1/place')
    await expect(page.getByRole('heading', { name: /place order/i })).toBeVisible()
    await expect(page.getByText(/acme ltd/i).first()).toBeVisible()
  })

  test('each advisory carries its own tick; a reason commits it; Undo reverses it', async ({ page }) => {
    // One control per advisory — the fixture has two (flag + correction).
    const markButtons = page.getByRole('button', { name: /mark as addressed/i })
    await expect(markButtons).toHaveCount(2)

    // Opening the picker never ticks by itself: three reason choices + a
    // Cancel appear (scoped to the advisory's own list item — the page has
    // its own Cancel button down by Confirm), and cancelling restores the
    // untouched state.
    await markButtons.first().click()
    const pickerCancel = page.locator('li').getByRole('button', { name: /cancel/i })
    await expect(pickerCancel).toHaveCount(1)
    await pickerCancel.click()
    await expect(page.getByRole('button', { name: /mark as addressed/i })).toHaveCount(2)
    await expect(page.getByRole('button', { name: /undo/i })).toHaveCount(0)

    // Picking a reason commits the tick: the item flips to its addressed
    // state (an Undo appears) and only the other advisory still offers the
    // control. The mock echoes the updated report; the page must render from
    // that response, not from local optimism.
    await page.getByRole('button', { name: /mark as addressed/i }).first().click()
    const pickerButtons = page.getByRole('button', { name: /fixed in the artwork|intentional|misread/i })
    await expect(pickerButtons).toHaveCount(3)
    await pickerButtons.first().click()
    await expect(page.getByRole('button', { name: /undo/i })).toHaveCount(1)
    await expect(page.getByRole('button', { name: /mark as addressed/i })).toHaveCount(1)

    // Undo restores the open state — reversibility is the safety valve on an
    // attributed sign-off.
    await page.getByRole('button', { name: /undo/i }).click()
    await expect(page.getByRole('button', { name: /undo/i })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /mark as addressed/i })).toHaveCount(2)
  })

  test('ticking every advisory reaches the all-addressed state; the report stays readable', async ({ page }) => {
    // Work the list: two advisories, two ticks.
    for (const n of [2, 1]) {
      await expect(page.getByRole('button', { name: /mark as addressed/i })).toHaveCount(n)
      await page.getByRole('button', { name: /mark as addressed/i }).first().click()
      await page.getByRole('button', { name: /fixed in the artwork|intentional|misread/i }).first().click()
      await expect(page.getByRole('button', { name: /undo/i })).toHaveCount(3 - n)
    }

    // Everything ticked: no open controls remain, both items show their
    // attributed addressed state, and the evidence is still on screen — the
    // tick records a judgement, it doesn't erase the finding (the fixture's
    // printed-vs-supplied values must survive).
    await expect(page.getByRole('button', { name: /mark as addressed/i })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /undo/i })).toHaveCount(2)
    await expect(page.getByText('derick@plak8.com').first()).toBeVisible()

    // The adjudication controls for OPEN flags (investigate / hold) stand
    // down on addressed items — there's nothing left to adjudicate.
    await expect(page.getByRole('button', { name: /investigate the history/i })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /hold this/i })).toHaveCount(0)
  })
})
