// The approve flow on the customer proof page (/p/:id) — the gates that stand
// between a customer and a legally-final sign-off.
//
// Approval triggers production scheduling and is final, so the ActionPanel
// stacks up to three acknowledgement ticks in front of Confirm: the
// disclaimer (when one is configured), the QR-contents check (only when the
// slot being approved carries a QR), and the earlier-version acknowledgement
// (only when the version on screen isn't the current one). Each gate has
// silently regressed value: a Confirm that enables early lets a customer
// sign off artwork they never confirmed; a gate that never releases makes the
// proof unapprovable and the customer emails us instead.
//
// The fixture module records every proof-action body on
// window.__cpProofActions, so these specs can assert the strongest fact of
// all: a gated submit sent NOTHING over the wire, and a successful one sent
// exactly one correctly-shaped payload.
//
// ⚠ Assert STRUCTURE, never wording — recipient names are fixture data.

import { test, expect, type Page, type Locator } from '@playwright/test'

// The panel's three acknowledgement rows are label-wrapped sr-only
// checkboxes; the visible label is the click target (the input itself fails
// Playwright's visibility actionability).
function gateRows(dialog: Locator): Locator {
  return dialog.locator('label').filter({ has: dialog.page().locator('input[type="checkbox"]') })
}

async function submittedActions(page: Page): Promise<any[]> {
  return page.evaluate(() => (window as any).__cpProofActions ?? [])
}

test.describe('approve panel gates', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/verify-harness/index.html?path=/p/cp-basic')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Kite & Co')
  })

  test('Approve opens the docked panel pre-filled and gated', async ({ page }) => {
    await page.getByRole('button', { name: /approve priya/i }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // The name field pre-fills with the recipient (the actor is usually the
    // recipient themselves) but stays editable.
    await expect(dialog.getByRole('textbox').first()).toHaveValue('Priya Sharma')

    // Two acknowledgements on this slot — disclaimer + QR — both unticked,
    // so Confirm starts disabled.
    await expect(dialog.getByRole('checkbox')).toHaveCount(2)
    await expect(dialog.getByRole('checkbox').nth(0)).not.toBeChecked()
    await expect(dialog.getByRole('checkbox').nth(1)).not.toBeChecked()
    await expect(dialog.getByRole('button', { name: /approve priya/i })).toBeDisabled()

    // Opening the panel swallows the band's own buttons (the panel IS the
    // form now) — the only "approve" control left is the gated Confirm.
    await expect(page.getByRole('button', { name: /approve priya/i })).toHaveCount(1)
  })

  test('each tick releases its own gate, and its helper hint with it', async ({ page }) => {
    // The most load-bearing test in the suite: the disclaimer and QR ticks
    // each independently gate Confirm, and a hint paragraph stands in for
    // each unmet gate. Counted before/after rather than by wording.
    await page.getByRole('button', { name: /approve priya/i }).click()
    const dialog = page.getByRole('dialog')
    const confirm = dialog.getByRole('button', { name: /approve priya/i })
    const rows = gateRows(dialog)
    await expect(rows).toHaveCount(2)

    const gatedParagraphs = await dialog.locator('p').count()
    await expect(confirm).toBeDisabled()

    // First tick (disclaimer): still gated by the QR check, one hint gone.
    await rows.nth(0).click()
    await expect(dialog.getByRole('checkbox').nth(0)).toBeChecked()
    await expect(confirm).toBeDisabled()
    await expect(dialog.locator('p')).toHaveCount(gatedParagraphs - 1)

    // Second tick (QR contents): every gate met, Confirm live, no hints.
    await rows.nth(1).click()
    await expect(dialog.getByRole('checkbox').nth(1)).toBeChecked()
    await expect(confirm).toBeEnabled()
    await expect(dialog.locator('p')).toHaveCount(gatedParagraphs - 2)

    // Unticking re-arms the gate — the acknowledgement is per-action state,
    // not a one-way latch.
    await rows.nth(0).click()
    await expect(confirm).toBeDisabled()
  })

  test('an empty name blocks the submit before anything is sent', async ({ page }) => {
    await page.getByRole('button', { name: /approve priya/i }).click()
    const dialog = page.getByRole('dialog')
    const rows = gateRows(dialog)
    await rows.nth(0).click()
    await rows.nth(1).click()

    const nameField = dialog.getByRole('textbox').first()
    await nameField.fill('')
    const confirm = dialog.getByRole('button', { name: /approve priya/i })
    await expect(confirm).toBeEnabled()
    const paragraphsBefore = await dialog.locator('p').count()
    await confirm.click()

    // The panel stays put, an error line appears, and — the part that
    // matters — no request left the page.
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('p')).toHaveCount(paragraphsBefore + 1)
    expect(await submittedActions(page)).toHaveLength(0)

    // Restoring the name lets the same panel complete.
    await nameField.fill('Priya Sharma')
    await confirm.click()
    await expect(dialog).toHaveCount(0)
    expect(await submittedActions(page)).toHaveLength(1)
  })

  test('a successful approve locks the band and sends exactly one payload', async ({ page }) => {
    await page.getByRole('button', { name: /approve priya/i }).click()
    const dialog = page.getByRole('dialog')
    const rows = gateRows(dialog)
    await rows.nth(0).click()
    await rows.nth(1).click()
    await dialog.getByRole('button', { name: /approve priya/i }).click()

    // Approve closes the panel and the band flips to its announced result
    // state (role=status) with the action buttons gone — the optimistic lock
    // that survives until the next page load re-reads the server.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /approve priya/i })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /request changes/i })).toHaveCount(0)
    await expect(page.getByRole('status').filter({ hasText: 'Priya' })).toBeVisible()

    // Exactly one proof-action left the page, shaped as the edge function
    // expects: the approve type, the slot's identity, and the QR tick.
    const actions = await submittedActions(page)
    expect(actions).toHaveLength(1)
    expect(actions[0].event_type).toBe('approve')
    expect(actions[0].proof_version_id).toBe('cp-basic-v1')
    expect(actions[0].name).toBe('Priya Sharma')
    expect(actions[0].actor_name).toBe('Priya Sharma')
    expect(actions[0].qr_confirmed).toBe(true)
  })

  test('Escape abandons the panel and re-arms an untouched band', async ({ page }) => {
    await page.getByRole('button', { name: /approve priya/i }).click()
    const dialog = page.getByRole('dialog')
    await gateRows(dialog).nth(0).click()
    await expect(dialog.getByRole('checkbox').nth(0)).toBeChecked()

    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // The band's buttons return, and a fresh open starts with every
    // acknowledgement reset — each approve action demands its own ticks.
    const approve = page.getByRole('button', { name: /approve priya/i })
    await expect(approve).toBeVisible()
    await expect(page.getByRole('button', { name: /request changes/i })).toBeVisible()
    await approve.click()
    await expect(page.getByRole('dialog').getByRole('checkbox').nth(0)).not.toBeChecked()
    expect(await submittedActions(page)).toHaveLength(0)
  })
})

test.describe('approve gates that depend on the slot and version', () => {
  test('the QR tick renders only when the slot actually has a QR', async ({ page }) => {
    // cp-multi's pending recipient has no QR anywhere, so their approve
    // panel carries the disclaimer tick alone. A QR tick appearing here
    // would gate approval on a check the customer cannot perform; the
    // reverse regression (no tick on cp-basic) is covered by the gate test
    // above asserting two rows.
    await page.goto('/verify-harness/index.html?path=/p/cp-multi')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Osei Partners')

    await page.getByRole('button', { name: /approve ben/i }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('checkbox')).toHaveCount(1)

    // And that single disclaimer tick is the whole gate.
    const confirm = dialog.getByRole('button', { name: /approve ben/i })
    await expect(confirm).toBeDisabled()
    await gateRows(dialog).first().click()
    await expect(confirm).toBeEnabled()
  })

  test('approving an earlier version demands its own acknowledgement', async ({ page }) => {
    await page.goto('/verify-harness/index.html?path=/p/cp-earlier')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Noor Haddad')

    // On the current version the approve panel has just the disclaimer.
    await page.getByRole('button', { name: /approve noor/i }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('checkbox')).toHaveCount(1)
    await dialog.getByRole('button', { name: /cancel/i }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Step back to v1. Requesting changes against a superseded design is
    // suppressed — approve is the only action offered on an old version.
    await page.getByRole('button', { name: /^view version 1\b/i }).click()
    await expect(page.getByRole('button', { name: /request changes/i })).toHaveCount(0)
    const approve = page.getByRole('button', { name: /approve noor/i })
    await expect(approve).toBeVisible()

    await approve.click()
    // The earlier-version acknowledgement joins the disclaimer, and Confirm
    // needs BOTH — ticking only the version ack must not release it.
    await expect(dialog.getByRole('checkbox')).toHaveCount(2)
    const confirm = dialog.getByRole('button', { name: /approve noor/i })
    await expect(confirm).toBeDisabled()
    const rows = gateRows(dialog)
    await rows.nth(0).click()
    await expect(confirm).toBeDisabled()
    await rows.nth(1).click()
    await expect(confirm).toBeEnabled()
    expect(await submittedActions(page)).toHaveLength(0)
  })
})
