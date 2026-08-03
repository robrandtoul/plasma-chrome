// The request-changes flow on the customer proof page (/p/:id), and the
// per-recipient banding that keeps one person's decision off another's card.
//
// A change request is the customer's main way of steering the design, and it
// is only useful with words attached — a request with no note gives the
// designer nothing to act on, so the panel must refuse to send one. The
// post-submit confirmation view exists because the admin-configured
// confirmation copy used to render BEFORE submit, where it read as if the
// request had already gone; these specs pin the correct order: form → send →
// confirmation → Done → locked band.
//
// The multi-recipient tests exist for the banding model itself: approvals
// are per-slot, so on a two-name proof one signed-off recipient must lock
// only their own band while the other's stays live — and the panel that
// opens must be attributed to the recipient whose button was pressed.
//
// The fixture module records every proof-action body on
// window.__cpProofActions, so "nothing was sent" is asserted directly.
//
// ⚠ Assert STRUCTURE, never wording — recipient names are fixture data.

import { test, expect, type Page } from '@playwright/test'

async function submittedActions(page: Page): Promise<any[]> {
  return page.evaluate(() => (window as any).__cpProofActions ?? [])
}

test.describe('request changes', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/verify-harness/index.html?path=/p/cp-basic')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Kite & Co')
  })

  test('an empty note refuses to send', async ({ page }) => {
    await page.getByRole('button', { name: /request changes/i }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // The form: pre-filled name field + the required note textarea. No
    // acknowledgement ticks on this path — those are approve-only.
    await expect(dialog.getByRole('textbox').first()).toHaveValue('Priya Sharma')
    await expect(dialog.getByRole('checkbox')).toHaveCount(0)
    const note = dialog.locator('textarea')
    await expect(note).toBeVisible()

    const paragraphsBefore = await dialog.locator('p').count()
    await dialog.getByRole('button', { name: /send/i }).click()

    // Still on the form (no Done button = no confirmation view), an error
    // line added, and nothing sent.
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: /done/i })).toHaveCount(0)
    await expect(dialog.locator('p')).toHaveCount(paragraphsBefore + 1)
    await expect(note).toBeVisible()
    expect(await submittedActions(page)).toHaveLength(0)
  })

  test('a filled note submits once and shows the confirmation view', async ({ page }) => {
    await page.getByRole('button', { name: /request changes/i }).click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('textarea').fill('Please nudge the logo up a little.')
    await dialog.getByRole('button', { name: /send/i }).click()

    // The panel swaps its form for the confirmation view: Done replaces
    // Cancel/Send and the note box is gone.
    await expect(dialog.getByRole('button', { name: /done/i })).toBeVisible()
    await expect(dialog.locator('textarea')).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: /send/i })).toHaveCount(0)

    // Exactly one proof-action, carrying the type, the slot and the note.
    const actions = await submittedActions(page)
    expect(actions).toHaveLength(1)
    expect(actions[0].event_type).toBe('request_changes')
    expect(actions[0].proof_version_id).toBe('cp-basic-v1')
    expect(actions[0].name).toBe('Priya Sharma')
    expect(actions[0].comment).toBe('Please nudge the logo up a little.')

    // Done dismisses the panel; the band is locked into its announced
    // result state with both action buttons gone.
    await dialog.getByRole('button', { name: /done/i }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('status').filter({ hasText: 'Priya' })).toBeVisible()
    await expect(page.getByRole('button', { name: /request changes/i })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /approve priya/i })).toHaveCount(0)
  })

  test('cancelling leaves no trace and resets the form', async ({ page }) => {
    await page.getByRole('button', { name: /request changes/i }).click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('textarea').fill('Half-typed thought…')
    await dialog.getByRole('button', { name: /cancel/i }).click()

    // Band restored, nothing sent, and a fresh open starts blank — an
    // abandoned request must not leak into the next one.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const reopen = page.getByRole('button', { name: /request changes/i })
    await expect(reopen).toBeVisible()
    expect(await submittedActions(page)).toHaveLength(0)

    await reopen.click()
    await expect(page.getByRole('dialog').locator('textarea')).toHaveValue('')
  })
})

test.describe('per-recipient banding on a two-name proof', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/verify-harness/index.html?path=/p/cp-multi')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Osei Partners')
  })

  test('one approved recipient locks only their own band', async ({ page }) => {
    // Amara has approved; Ben has not. The page must offer the pending
    // actions for Ben ALONE — an approve button naming Amara would invite a
    // double sign-off, and zero buttons would strand Ben.
    await expect(page.getByRole('button', { name: /approve ben/i })).toHaveCount(1)
    await expect(page.getByRole('button', { name: /approve amara/i })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /request changes/i })).toHaveCount(1)

    // Amara's card still renders (locked, not hidden) with her approved
    // state marked on it.
    await expect(page.getByText(/Amara's card/)).toBeVisible()
    await expect(page.getByText(/approved/i).first()).toBeVisible()
  })

  test('the panel opens attributed to the recipient whose button was pressed', async ({ page }) => {
    await page.getByRole('button', { name: /request changes/i }).click()

    // Only Ben's band is pending, so the request panel must carry Ben's
    // slot — the dialog itself is labelled with the action, and the name
    // field pre-fills with the recipient it will submit for.
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Ben')
    await expect(dialog.getByRole('textbox').first()).toHaveValue('Ben Osei')

    await dialog.locator('textarea').fill('Swap my mobile number for the office line.')
    await dialog.getByRole('button', { name: /send/i }).click()
    await expect(dialog.getByRole('button', { name: /done/i })).toBeVisible()

    const actions = await submittedActions(page)
    expect(actions).toHaveLength(1)
    expect(actions[0].name).toBe('Ben Osei')
    expect(actions[0].proof_version_id).toBe('cp-multi-v1')
  })
})
