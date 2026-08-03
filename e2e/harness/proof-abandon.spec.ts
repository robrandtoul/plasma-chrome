// The Abandon-project dialog (migration 000366) in every state it can reach.
//
// Runs against the ?path=/abandon-dialog rig (&state=silent|blocked|retry),
// plus the real wiring on /proofs/p-open. The rig exists because the dialog's
// states depend on props the real page only produces under conditions an
// offline harness can't stage (a linked conversation, a failed send).
//
// What these lock in, and the real failures each exists to catch:
//
//   1. the SILENT default must stay a plain confirm — no message machinery
//      visible until opted into. Silence is the deliberate default (most
//      abandons are ghosted leads); a dialog that starts with the notice
//      revealed, or worse pre-ticked, would email "we've closed your project"
//      to customers nobody meant to contact.
//   2. ticking the box reveals an EDITABLE, PRE-RENDERED message (the
//      template fell back to the shipped default and its placeholders were
//      substituted), and the primary is still the abandon action.
//   3. a ticked box may not send an empty message: the confirm gates on the
//      body. Closing silently would still be correct, but the designer asked
//      for a message and would silently not get one.
//   4. BLOCKED: when the notice can't be offered, the checkbox is disabled
//      and explains itself with a different explanation from the silent
//      default's — instead of failing at send time — while the silent close
//      stays available.
//   5. RETRY: once the project is closed but its notice failed, the dialog
//      becomes a retry of the message ALONE. Nothing may offer to close the
//      project again — the close already happened, and a second offer invites
//      a designer to "abandon" a project that is already abandoned.
//
// ⚠ Assert STRUCTURE, never wording. The one negative wording assertion —
// no button in the retry state matches /abandon/i — IS the retry state's
// contract, not a copy check.

import { test, expect, type Page } from '@playwright/test'

const RIG = '/verify-harness/index.html?path=/abandon-dialog'

// The explainer paragraph under the notify checkbox (label + adjacent p).
function checkboxExplainer(page: Page) {
  return page.getByRole('dialog').locator('label + p')
}

test.describe('abandon dialog — the silent default', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(RIG)
    await expect(page.getByRole('dialog')).toBeVisible()
  })

  test('starts as a plain confirm: no message machinery until opted in', async ({ page }) => {
    const dialog = page.getByRole('dialog')
    // One unticked checkbox, no textarea, and exactly the confirm pair of
    // buttons — byte-for-byte the plain confirm this dialog replaced.
    await expect(dialog.getByRole('checkbox')).toHaveCount(1)
    await expect(dialog.getByRole('checkbox')).not.toBeChecked()
    await expect(dialog.getByRole('checkbox')).toBeEnabled()
    await expect(dialog.getByRole('textbox')).toHaveCount(0)
    await expect(dialog.getByRole('button')).toHaveCount(2)
    // The primary (last) button is the abandon action and is live.
    await expect(dialog.getByRole('button').last()).toHaveAccessibleName(/abandon/i)
    await expect(dialog.getByRole('button').last()).toBeEnabled()
  })

  test('ticking reveals the pre-rendered editable message, primary still abandons', async ({ page }) => {
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('checkbox').check()

    // The message appears, editable, already rendered from the fallback
    // template: non-empty, and with no unrendered {placeholders} left in it —
    // raw braces reaching a customer is the template-pipeline failure mode.
    const body = dialog.getByRole('textbox')
    await expect(body).toBeVisible()
    await expect(body).toBeEnabled()
    const value = await body.inputValue()
    expect(value.trim().length).toBeGreaterThan(0)
    expect(value).not.toContain('{')

    // Still the abandon action, still live, cancel still available.
    await expect(dialog.getByRole('button').last()).toHaveAccessibleName(/abandon/i)
    await expect(dialog.getByRole('button').last()).toBeEnabled()
    await expect(dialog.getByRole('button')).toHaveCount(2)

    // Unticking folds the message away again — back to the plain confirm.
    await dialog.getByRole('checkbox').uncheck()
    await expect(dialog.getByRole('textbox')).toHaveCount(0)
  })

  test('a ticked box refuses to send an empty message', async ({ page }) => {
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('checkbox').check()
    const body = dialog.getByRole('textbox')
    await expect(body).toBeVisible()

    // Emptying the message disables the confirm: the designer opted into a
    // message, so confirming must not quietly close-and-send-nothing.
    await body.fill('')
    await expect(dialog.getByRole('button').last()).toBeDisabled()

    // Typing anything re-arms it.
    await body.fill('A one-line note.')
    await expect(dialog.getByRole('button').last()).toBeEnabled()
  })
})

test.describe('abandon dialog — notify blocked', () => {
  test('the notify option is disabled, explains itself, and silent close survives', async ({ page }) => {
    // Capture the silent state's explainer first so "explains itself" can be
    // asserted as a DIFFERENCE (the copy under the checkbox changes when
    // blocked) rather than as pinned wording.
    await page.goto(RIG)
    await expect(page.getByRole('dialog')).toBeVisible()
    const silentExplainer = (await checkboxExplainer(page).innerText()).trim()

    await page.goto(`${RIG}&state=blocked`)
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // Disabled — the option can't be taken, so the message can never reveal.
    await expect(dialog.getByRole('checkbox')).toBeDisabled()
    await expect(dialog.getByRole('textbox')).toHaveCount(0)

    // A reason is shown, and it is not the silent default's line.
    const blockedExplainer = (await checkboxExplainer(page).innerText()).trim()
    expect(blockedExplainer.length).toBeGreaterThan(0)
    expect(blockedExplainer).not.toBe(silentExplainer)

    // Closing silently is unaffected by the blocker.
    await expect(dialog.getByRole('button').last()).toHaveAccessibleName(/abandon/i)
    await expect(dialog.getByRole('button').last()).toBeEnabled()
  })
})

test.describe('abandon dialog — retry after a failed notice', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${RIG}&state=retry`)
    await expect(page.getByRole('dialog')).toBeVisible()
  })

  test('offers only the message — nothing closes the project again', async ({ page }) => {
    const dialog = page.getByRole('dialog')
    // No opt-in checkbox: the notify decision is already made.
    await expect(dialog.getByRole('checkbox')).toHaveCount(0)
    // The message is up-front, pre-filled, ready to retry.
    const body = dialog.getByRole('textbox')
    await expect(body).toBeVisible()
    expect((await body.inputValue()).trim().length).toBeGreaterThan(0)
    // The failure that put us here is surfaced (the rig passes this exact
    // error in as a fixture, like the pinned pin coordinates elsewhere).
    await expect(dialog.getByText('Help Scout conversation not found')).toBeVisible()
    // Two buttons, and NEITHER is an abandon action — the project is already
    // closed, so any button reading as "abandon" would be offering a lie.
    await expect(dialog.getByRole('button')).toHaveCount(2)
    await expect(dialog.getByRole('button', { name: /abandon/i })).toHaveCount(0)
  })

  test('the retry send stays gated on a non-empty message', async ({ page }) => {
    const dialog = page.getByRole('dialog')
    const body = dialog.getByRole('textbox')
    await expect(body).toBeVisible()

    await body.fill('')
    await expect(dialog.getByRole('button').last()).toBeDisabled()
    await body.fill('Trying the note again.')
    await expect(dialog.getByRole('button').last()).toBeEnabled()
  })
})

test.describe('the real page wires the dialog (p-open)', () => {
  test('Abandon in the overflow menu opens the real dialog with the blocker computed', async ({ page }) => {
    // End-to-end through ProofDetailPage rather than the rig: the menu action
    // must reach THIS dialog, and the page must hand it a computed blocker.
    // The harness fixture has no linked Help Scout conversation and resolves
    // replies-enabled to off, so the notify option arrives disabled — proving
    // the page derived a blocker instead of offering a send that would fail.
    // (The tickable fallback-template path is covered on the rig above, where
    // the blocker is absent.) The template fetch resolves empty here and must
    // fall back without an error reaching the console.
    const errors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error' && m.text().includes('[harness] uncaught render error')) {
        errors.push(m.text())
      }
    })

    await page.goto('/verify-harness/index.html?path=/proofs/p-open')
    await expect(page.getByRole('heading', { name: /realise/i })).toBeVisible()

    await page.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: /abandon/i }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('checkbox')).toHaveCount(1)
    await expect(dialog.getByRole('checkbox')).toBeDisabled()
    // Silent close remains the live primary.
    await expect(dialog.getByRole('button').last()).toHaveAccessibleName(/abandon/i)
    await expect(dialog.getByRole('button').last()).toBeEnabled()

    // Cancelling returns to the intact detail page.
    await dialog.getByRole('button').first().click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: /realise/i })).toBeVisible()

    expect(errors).toEqual([])
  })
})
