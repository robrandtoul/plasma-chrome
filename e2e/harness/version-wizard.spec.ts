// The proof-type wizard on the new-version form (/proofs/:id/versions/new) —
// the page-level behaviour the wizard's pure-logic unit tests cannot see.
//
// resolveShape/deriveFormState are already unit-tested; what has actually
// broken in production is the WIRING between a resolved shape and the rest of
// the form. Each shape must swap in its own editing surface (names roster /
// layouts editor / variants editor / per-slot grid) and stand the others
// down; the split-guard terminals must never resolve into a saveable state;
// and — the incident this file chiefly exists for — switching a carried
// multi-recipient project to Selection destroys the roster and every carried
// image on save, which once silently rebuilt a customer's 8-name proof as a
// two-direction pick-one holding a single person's card. The guard that now
// fronts that switch (selectionShapeLoss + window.confirm) is only real if
// the confirm actually fires on the page, counts the real loss, and a
// decline truly leaves the form untouched.
//
// Runs against the verify harness (fixtures in
// verify-harness/fixtures/version-form.ts): vf-blank is a v1 creation form
// (wizard unanswered), vf-open a two-recipient continuation with two carried
// per-name images — the exact shape the guard protects.
//
// ⚠ Assert STRUCTURE, never wording. The wizard's radio groups carry stable
// code-level input names (wizard-family, wizard-layouts, …), which is what
// these specs key on; recipient names are fixture data.

import { test, expect, type Page } from '@playwright/test'

const FAMILY = 'input[name="wizard-family"]'
const LAYOUTS_Q = 'input[name="wizard-layouts"]'
const SAME_MATERIAL_Q = 'input[name="wizard-same-material"]'
const SELECTION_MATERIAL_Q = 'input[name="wizard-selection-material"]'
const INTENT_Q = 'input[name="wizard-selection-intent"]'
const PERSONALISED_Q = 'input[name="wizard-personalised"]'

// The wizard's radios are sr-only inside their option cards, so the visible
// label is the click target (the input itself fails visibility actionability).
function answer(page: Page, input: string, value: string) {
  return page.locator(`label:has(${input}[value="${value}"])`).click()
}

// Structural handles for the three mutually-exclusive editing surfaces.
const roster = (page: Page) => page.getByRole('group', { name: /names on this order/i })
const addDirection = (page: Page) => page.getByRole('button', { name: /add direction/i })
const addLayout = (page: Page) => page.getByRole('button', { name: /add layout/i })
// The standard per-slot grid's section-level drop zone is the only
// role=button on the page carrying aria-disabled, so it uniquely identifies
// the standard image surface (the variant/layout drop zones carry no
// aria-disabled).
const gridZone = (page: Page) => page.locator('div[role="button"][aria-disabled]')
const submit = (page: Page) => page.locator('button[type="submit"]')

test.describe('proof-type wizard shape resolution (fresh project)', () => {
  // Every native dialog is captured (and dismissed) so any test can assert
  // that NO confirm fired on a non-destructive path — the "spurious confirm
  // froze the page" regression class called out in handleWizardChange.
  let dialogs: string[]

  test.beforeEach(async ({ page }) => {
    dialogs = []
    page.on('dialog', (d) => {
      dialogs.push(d.message())
      void d.dismiss()
    })
    await page.goto('/verify-harness/index.html?path=/proofs/vf-blank/versions/new')
    await expect(page.locator(FAMILY)).toHaveCount(3)
  })

  test('opens on one three-way question, everything downstream stood down, Save blocked', async ({ page }) => {
    // Only Q1 is open — progressive disclosure means no branch question
    // exists in the DOM yet.
    await expect(page.locator(LAYOUTS_Q)).toHaveCount(0)
    await expect(page.locator(SELECTION_MATERIAL_Q)).toHaveCount(0)
    // No shape → no shape-specific surface, and no saveable state.
    await expect(roster(page)).toHaveCount(0)
    await expect(addDirection(page)).toHaveCount(0)
    await expect(addLayout(page)).toHaveCount(0)
    await expect(submit(page)).toBeDisabled()
  })

  test('Recipients resolves in one answer and raises the names roster', async ({ page }) => {
    await answer(page, FAMILY, 'recipients')

    // The answered question collapses to a row with a Change control…
    await expect(page.locator(FAMILY)).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^change$/i })).toHaveCount(1)
    // …and the recipients-only surface appears while the other two stay away.
    await expect(roster(page)).toBeVisible()
    await expect(addDirection(page)).toHaveCount(0)
    await expect(addLayout(page)).toHaveCount(0)
    // Resolution alone doesn't unlock Save — the roster and images are empty.
    await expect(submit(page)).toBeDisabled()
    expect(dialogs).toHaveLength(0)
  })

  test('Set (single) resolves with no roster, and the personalisation question follows the material', async ({ page }) => {
    await answer(page, FAMILY, 'set')
    await expect(page.locator(LAYOUTS_Q)).toHaveCount(2)
    await answer(page, LAYOUTS_Q, 'one')

    // Resolved with no open wizard question left, and none of the three
    // special surfaces (a single set uses the standard shared-slot grid).
    await expect(page.locator('input[name^="wizard-"]')).toHaveCount(0)
    await expect(roster(page)).toHaveCount(0)
    await expect(addLayout(page)).toHaveCount(0)
    await expect(addDirection(page)).toHaveCount(0)
    await expect(gridZone(page)).toHaveCount(1)

    // The material-gated question: picking a material that supports
    // personalisation REVEALS a new required question (resolution retracts
    // until it is answered) — pure page-level wiring between the wizard and
    // the Design section that the unit tests cannot reach.
    await page.getByRole('combobox').selectOption('vf-mat-steel')
    await expect(page.locator(PERSONALISED_Q)).toHaveCount(2)
    await expect(page.getByRole('button', { name: /^change$/i })).toHaveCount(2)
    await answer(page, PERSONALISED_Q, 'yes')
    await expect(page.locator(PERSONALISED_Q)).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^change$/i })).toHaveCount(3)

    // Switching to a material with no personalisation support withdraws the
    // question AND its answered row — the wizard never shows a control that
    // cannot apply.
    await page.getByRole('combobox').selectOption('vf-mat-wood')
    await expect(page.locator('input[name^="wizard-"]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^change$/i })).toHaveCount(2)
    expect(dialogs).toHaveLength(0)
  })

  test('Set (collection) opens the layouts editor seeded with two rows', async ({ page }) => {
    await answer(page, FAMILY, 'set')
    await answer(page, LAYOUTS_Q, 'several')
    await expect(page.locator(SAME_MATERIAL_Q)).toHaveCount(2)
    await answer(page, SAME_MATERIAL_Q, 'yes')

    // The layouts editor appears pre-seeded with the two-row minimum, each
    // row carrying its own title input.
    await expect(addLayout(page)).toBeVisible()
    const editor = page.locator('section').filter({ has: page.getByRole('button', { name: /add layout/i }) })
    await expect(editor.locator('li')).toHaveCount(2)
    await expect(editor.locator('li input[type="text"]')).toHaveCount(2)
    // At the two-row floor there is no remove control at all; adding a third
    // row brings one per row.
    await expect(editor.getByRole('button', { name: /remove layout/i })).toHaveCount(0)
    await addLayout(page).click()
    await expect(editor.locator('li')).toHaveCount(3)
    await expect(editor.getByRole('button', { name: /remove layout/i })).toHaveCount(3)

    // The standard per-slot grid stands down — a collection's images live in
    // the editor, so two competing upload surfaces would be a real bug.
    await expect(gridZone(page)).toHaveCount(0)
    await expect(roster(page)).toHaveCount(0)
    await expect(submit(page)).toBeDisabled()
    expect(dialogs).toHaveLength(0)
  })

  test('Selection (same material) opens the variants editor with a two-direction floor', async ({ page }) => {
    await answer(page, FAMILY, 'selection')
    await expect(page.locator(SELECTION_MATERIAL_Q)).toHaveCount(2)
    await answer(page, SELECTION_MATERIAL_Q, 'same')

    // Two seeded direction rows, each with a title input; the floor is
    // enforced structurally — both remove buttons render disabled.
    await expect(addDirection(page)).toBeVisible()
    const editor = page.locator('section').filter({ has: page.getByRole('button', { name: /add direction/i }) })
    await expect(editor.locator('li')).toHaveCount(2)
    const removes = editor.getByRole('button', { name: /remove direction/i })
    await expect(removes).toHaveCount(2)
    await expect(removes.nth(0)).toBeDisabled()
    await expect(removes.nth(1)).toBeDisabled()

    // Roster and standard grid stand down, but the version-level material
    // picker STAYS — a same-material selection still prices normally.
    await expect(roster(page)).toHaveCount(0)
    await expect(gridZone(page)).toHaveCount(0)
    await expect(page.getByRole('combobox')).toHaveCount(1)
    await expect(submit(page)).toBeDisabled()
    // A fresh project carries nothing, so entering Selection must NOT nag.
    expect(dialogs).toHaveLength(0)
  })

  test('QS2 intent guard: only "they will pick one" resolves; order-both answers terminate in split guidance', async ({ page }) => {
    await answer(page, FAMILY, 'selection')
    await answer(page, SELECTION_MATERIAL_Q, 'different')
    await expect(page.locator(INTENT_Q)).toHaveCount(3)

    // "Asked for a price on each" → terminal guidance (a route out to
    // /proofs/new), no variants editor, and no saveable state.
    await answer(page, INTENT_Q, 'prices')
    await expect(page.locator('a[href="/proofs/new"]')).toBeVisible()
    await expect(addDirection(page)).toHaveCount(0)
    await expect(submit(page)).toBeDisabled()

    // "Might order both / unsure" → the same terminal, still no editor.
    await page.getByRole('button', { name: /^change$/i }).last().click()
    await expect(page.locator(INTENT_Q)).toHaveCount(3)
    await answer(page, INTENT_Q, 'unsure')
    await expect(page.locator('a[href="/proofs/new"]')).toBeVisible()
    await expect(addDirection(page)).toHaveCount(0)
    await expect(submit(page)).toBeDisabled()

    // "They'll pick one, prices can wait" is the ONLY intent that resolves:
    // the terminal goes, the variants editor arrives, and — per-direction
    // pricing — the version-level material decision disappears entirely.
    await page.getByRole('button', { name: /^change$/i }).last().click()
    await answer(page, INTENT_Q, 'pick')
    await expect(addDirection(page)).toBeVisible()
    await expect(page.locator('a[href="/proofs/new"]')).toHaveCount(0)
    await expect(page.getByRole('combobox')).toHaveCount(0)
    expect(dialogs).toHaveLength(0)
  })
})

// ── The selection-loss guard ─────────────────────────────────────────────────
//
// vf-open loads as a collapsed continuation: v1 is a two-recipient Recipients
// version whose two per-name images carry forward, so the form is valid (Save
// enabled) the moment it loads. This is the state a real designer was in when
// they switched an 8-name proof to Selection and the save silently dropped
// the whole roster and every carried card. The guard must (a) fire BEFORE any
// state is applied, (b) count the actual loss, and (c) on decline leave the
// wizard, the roster and the carried images exactly as they were.

test.describe('the selection-loss guard on a carried project', () => {
  const imageSection = (page: Page) =>
    page.locator('section').filter({ has: page.locator('div[role="button"][aria-disabled]') })

  async function openWizard(page: Page) {
    await page.goto('/verify-harness/index.html?path=/proofs/vf-open/versions/new')
    // The continuation collapses behind the summary card; the wizard only
    // exists once the form is expanded.
    const edit = page.getByRole('button', { name: /edit details/i })
    await expect(edit).toBeVisible()
    // Both carried per-name images render before expansion (the image column
    // is not collapsed), so the loss the guard will count is on screen.
    await expect(imageSection(page).locator('img')).toHaveCount(2)
    await edit.click()
    await expect(roster(page)).toBeVisible()
  }

  test('switching to Selection asks first, counts the real loss, and declining leaves everything standing', async ({ page }) => {
    const dialogs: string[] = []
    page.on('dialog', (d) => {
      dialogs.push(d.message())
      void d.dismiss() // decline
    })
    await openWizard(page)
    await expect(roster(page).getByRole('button', { name: /^remove /i })).toHaveCount(2)
    await expect(submit(page)).toBeEnabled()

    // Reopen Q1 and walk to Selection → same material. The confirm fires on
    // the answer that first RESOLVES a Selection shape.
    await page.getByRole('button', { name: /^change$/i }).first().click()
    await expect(page.locator(FAMILY)).toHaveCount(3)
    await answer(page, FAMILY, 'selection')
    await expect(page.locator(SELECTION_MATERIAL_Q)).toHaveCount(2)
    await answer(page, SELECTION_MATERIAL_Q, 'same')

    // Exactly one confirm, and it counts the loss: the 2-name set and both
    // carried images. A guard that fires without the numbers is the
    // click-through kind of warning the incident proved worthless.
    await expect.poll(() => dialogs.length).toBe(1)
    expect(dialogs[0]).toMatch(/\b2-name\b/)
    expect(dialogs[0]).toMatch(/\b2 images\b/)

    // Declined: no variants editor, and the wizard rolled back to the open
    // (unanswered) material question rather than displaying an answer the
    // form never adopted.
    await expect(addDirection(page)).toHaveCount(0)
    await expect(page.locator(SELECTION_MATERIAL_Q)).toHaveCount(2)
    for (const radio of await page.locator(SELECTION_MATERIAL_Q).all()) {
      await expect(radio).not.toBeChecked()
    }
    // The carried artwork never flinched.
    await expect(imageSection(page).locator('img')).toHaveCount(2)

    // Walking back to Recipients restores the full previous state: roster
    // with both chips, both carried images, Save enabled — the decline cost
    // the designer nothing.
    await page.getByRole('button', { name: /^change$/i }).first().click()
    await answer(page, FAMILY, 'recipients')
    await expect(roster(page)).toBeVisible()
    await expect(roster(page).getByRole('button', { name: /^remove /i })).toHaveCount(2)
    await expect(imageSection(page).locator('img')).toHaveCount(2)
    await expect(submit(page)).toBeEnabled()
    // Returning to Recipients must not raise a second confirm.
    expect(dialogs).toHaveLength(1)
  })

  test('accepting the switch enters Selection and stands the roster and grid down', async ({ page }) => {
    const dialogs: string[] = []
    page.on('dialog', (d) => {
      dialogs.push(d.message())
      void d.accept()
    })
    await openWizard(page)

    await page.getByRole('button', { name: /^change$/i }).first().click()
    await answer(page, FAMILY, 'selection')
    await answer(page, SELECTION_MATERIAL_Q, 'same')
    await expect.poll(() => dialogs.length).toBe(1)

    // The variants editor takes over with its two seeded empty directions;
    // the roster and the carried grid stand down; and the form is no longer
    // saveable until the directions are named and filled — so the accepted
    // switch cannot silently save a half-formed Selection.
    await expect(addDirection(page)).toBeVisible()
    const editor = page.locator('section').filter({ has: page.getByRole('button', { name: /add direction/i }) })
    await expect(editor.locator('li')).toHaveCount(2)
    await expect(roster(page)).toHaveCount(0)
    await expect(gridZone(page)).toHaveCount(0)
    await expect(submit(page)).toBeDisabled()
    expect(dialogs).toHaveLength(1)
  })
})
