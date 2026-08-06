// The two letterpress layer-colour gates, and the fact that they DISAGREE
// about gilded letterpress.
//
// A letterpress card is three bonded layers of Colorplan. That trio isn't
// decoration: the direct Stock Control hand-off builds the job's entire
// material line from it (`create_order_handoff` emits {front, core, back}
// instead of a material_id, and `_resolve_letterpress_combo` turns that into
// the tracked stock the job allocates against). So BOTH letterpress codes
// have to capture it. But only the un-gilded one should SHOW the customer the
// layered cross-section, because gilding covers the very edge that panel
// illustrates.
//
// Until 2026-08-06 those were one setting, so one of the two jobs was always
// wrong. It was set to un-gilded — right for the customer page — which left
// gilded versions storing null colours, and a gilded in-house order then
// failed Confirm on `letterpress_colours_missing` with no way to fix it from
// the app (an approved proof locks version editing). Order 403976 (Ayla
// Advisory) needed a direct database update.
//
// The real failures these catch:
//
//   1. gilded loses its pickers again — the deadlock returns, and it is
//      invisible until a customer has paid and the order won't hand off.
//   2. the three colours stop BLOCKING save for gilded, which is what makes
//      the deadlock structurally impossible rather than merely unlikely.
//   3. the split gets tidied back into one value and the customer starts
//      seeing a construction diagram for an edge their card doesn't have.
//   4. the capture gate gets widened too far and non-letterpress materials
//      start asking for Colorplan layers.
//
// The two customer fixtures are deliberately identical apart from the
// material code — same colour trio on both — so a passing pair proves the
// page is gating on the material and not merely on the data being absent,
// which is what used to hold gilded out by accident.

import { test, expect } from '@playwright/test'

const FORM = '/verify-harness/index.html?path=/proofs/vf-blank/versions/new'

// The three pickers live under one "Paper layers" heading so a designer reads
// them as a single decision; that grouping is what we locate.
const paperLayers = (page: import('@playwright/test').Page) =>
  page.getByText('Paper layers', { exact: true })

// The layer labels aren't associated with their selects (no htmlFor), so
// getByLabel can't reach them — assert the labels themselves instead.
const layerLabels = ['Front', 'Core', 'Back'] as const

// Material is the first combobox on the form, and selecting one adds more
// (ink count, then the three colours), so pin it to .first() rather than a
// bare getByRole. Selected by fixture id like the other version-form specs:
// values are stable, option wording isn't.
async function pickMaterial(page: import('@playwright/test').Page, id: string) {
  await page.getByRole('combobox').first().selectOption(id)
}

const GILDED = 'vf-mat-lp-gilded'
const PLAIN = 'vf-mat-lp'
const STEEL = 'vf-mat-steel'
const WOOD = 'vf-mat-wood'

test.describe('designer form — which materials capture the layer colours', () => {
  test('gilded letterpress offers the three pickers', async ({ page }) => {
    // THE FIX. Gilded is the same three bonded layers as plain; the gilding
    // only covers the edge. Without this the version saves with null colours
    // and the order cannot be handed off.
    await page.goto(FORM)
    await pickMaterial(page, GILDED)
    await expect(paperLayers(page)).toBeVisible()
    for (const layer of layerLabels) {
      await expect(page.getByText(layer, { exact: true })).toBeVisible()
    }
  })

  test('gilded letterpress cannot be saved until all three are set', async ({ page }) => {
    // Rendering the pickers isn't enough on its own — a designer who skips
    // them would recreate the stranded order. The save-blocker list is what
    // makes it structural, so assert the button is actually held closed and
    // that all three colours are named as reasons.
    await page.goto(FORM)
    await pickMaterial(page, GILDED)

    const save = page.getByRole('button', { name: /save version/i })
    await expect(save).toBeDisabled()

    const blockers = page.getByText(/^To save:/)
    await expect(blockers).toContainText(/front colour/i)
    await expect(blockers).toContainText(/core colour/i)
    await expect(blockers).toContainText(/back colour/i)
  })

  test('plain letterpress still offers them', async ({ page }) => {
    await page.goto(FORM)
    await pickMaterial(page, PLAIN)
    await expect(paperLayers(page)).toBeVisible()
  })

  test('non-letterpress materials do not', async ({ page }) => {
    // Guards the other direction: the capture gate is an allow-list, not
    // "anything with a paper-ish name".
    await page.goto(FORM)

    await pickMaterial(page, STEEL)
    await expect(paperLayers(page)).toHaveCount(0)

    await pickMaterial(page, WOOD)
    await expect(paperLayers(page)).toHaveCount(0)
  })
})

test.describe('customer page — which materials show the cross-section', () => {
  // Both fixtures carry the SAME trio (Natural / Ebony / Natural). Only the
  // material code differs, so these two tests together prove the gate.
  test('un-gilded letterpress shows the construction panel', async ({ page }) => {
    await page.goto('/verify-harness/index.html?path=/p/cp-letterpress')
    await expect(page.getByRole('heading', { name: 'Construction' })).toBeVisible()
  })

  test('gilded letterpress does NOT, despite carrying the same colours', async ({ page }) => {
    // The gilding covers the layered edge, so the panel would describe a
    // detail the customer's card doesn't have. This is the half that has to
    // survive the capture gate widening to both codes.
    await page.goto('/verify-harness/index.html?path=/p/cp-gilded')

    // The page has loaded the gilded proof (not merely failed to render):
    // its spec sheet names the material before we assert the absence.
    // exact:true pins the spec-sheet value; the masthead summary line
    // mentions the material too, so a loose match is ambiguous.
    await expect(page.getByText('Letterpress with gilding', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Construction' })).toHaveCount(0)
  })
})
