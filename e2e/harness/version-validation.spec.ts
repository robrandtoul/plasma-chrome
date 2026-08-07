// Save-gating and required-field feedback on the new-version form
// (/proofs/:id/versions/new).
//
// The form's validation model is ALWAYS-ON: a failing field carries its rose
// note from the first render (shouldHighlight is a live derivation, not a
// post-submit flag), the Save button is disabled until every check passes,
// and the sticky action bar prints the full reason list next to the button.
// That model was chosen precisely because the Save button is disabled while
// invalid — a click can never arrive to trigger after-the-fact highlighting,
// so anything gated on "submit attempted" would simply never show and the
// designer would face a greyed button with no explanation (the exact
// discoverability failure the code comments record).
//
// What real failure each spec catches:
//   * a Save button that is enabled while a required field is empty lets a
//     half-built version reach a customer;
//   * a highlight that does not clear when its field is filled (or a blocker
//     list that goes stale) makes the form lie about what is left, and the
//     designer hunts for a problem that no longer exists;
//   * a blocker list that never empties (or a button that stays disabled
//     when everything is valid) makes the form unsaveable outright.
//
// Runs against the verify harness (fixtures in
// verify-harness/fixtures/version-form.ts): vf-blank is the v1 creation form
// (commercial defaults pre-filled, everything else missing), vf-open a fully
// valid two-recipient continuation whose Save starts enabled.
//
// ⚠ Assert STRUCTURE, never wording: element presence/absence, counts,
// enabled/disabled, and the title attribute's existence — not its copy.

import { test, expect, type Page } from '@playwright/test'

const FAMILY = 'input[name="wizard-family"]'

function answer(page: Page, input: string, value: string) {
  return page.locator(`label:has(${input}[value="${value}"])`).click()
}

const submit = (page: Page) => page.locator('button[type="submit"]')
const roster = (page: Page) => page.getByRole('group', { name: /names on this order/i })
// The sticky bar's reason line renders only while Save is blocked.
const blockerLine = (page: Page) => page.getByText(/to save:/i)
// The standard grid's section drop zone — the only role=button carrying
// aria-disabled — anchors the image section.
const imageSection = (page: Page) =>
  page.locator('section').filter({ has: page.locator('div[role="button"][aria-disabled]') })

// A real (1×1) JPEG so the file passes the form's image/jpeg accept filter.
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  'base64',
)

test.describe('save gating on a fresh form (vf-blank)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/verify-harness/index.html?path=/proofs/vf-blank/versions/new')
    await expect(page.locator(FAMILY)).toHaveCount(3)
  })

  test('born blocked: Save disabled and the reasons printed at the button', async ({ page }) => {
    await expect(submit(page)).toBeDisabled()
    // The button explains itself twice over: a reason line beside it and the
    // same sentence as its tooltip. Presence is the contract; the copy isn't.
    await expect(blockerLine(page)).toBeVisible()
    await expect(submit(page)).toHaveAttribute('title', /./)
    // At least one field already wears its rose note before any click.
    await expect(page.locator('p.text-out').first()).toBeVisible()
  })

  test('filling a field clears its own highlight live, with no save attempt in between', async ({ page }) => {
    await answer(page, FAMILY, 'recipients')

    // The material picker wears a rose note while empty; picking a material
    // clears it immediately — no submit click is ever made in this test.
    const material = page.getByRole('combobox')
    const materialWrap = material.locator('..')
    await expect(materialWrap.locator('p.text-out')).toHaveCount(1)
    await material.selectOption('vf-mat-steel')
    await expect(materialWrap.locator('p.text-out')).toHaveCount(0)

    // Same for the roster: rose note while empty, gone the moment a chip
    // commits.
    const rosterWrap = roster(page).locator('..')
    await expect(rosterWrap.locator('p.text-out')).toHaveCount(1)
    await roster(page).getByRole('textbox').fill('Kim Field')
    await roster(page).getByRole('textbox').press('Enter')
    await expect(roster(page).getByRole('button', { name: /^remove /i })).toHaveCount(1)
    await expect(rosterWrap.locator('p.text-out')).toHaveCount(0)

    // Images are still outstanding, so the door stays shut.
    await expect(submit(page)).toBeDisabled()
    await expect(blockerLine(page)).toBeVisible()
  })

  test('the last requirement flips Save on — and the explanations stand down with it', async ({ page }) => {
    await answer(page, FAMILY, 'recipients')
    await page.getByRole('combobox').selectOption('vf-mat-steel')
    await roster(page).getByRole('textbox').fill('Kim Field')
    await roster(page).getByRole('textbox').press('Enter')
    await expect(roster(page).getByRole('button', { name: /^remove /i })).toHaveCount(1)

    // One-sided halves the slot universe to a single front slot for the one
    // recipient — so exactly one upload satisfies the images check.
    await page.locator('label:has(input[name="sidedness"][value="one-sided"])').click()
    await expect(submit(page)).toBeDisabled()

    // The image section holds two file inputs now: the section-level batch
    // zone, then the one empty slot. Upload into the slot.
    const inputs = imageSection(page).locator('input[type="file"]')
    await expect(inputs).toHaveCount(2)
    await inputs.nth(1).setInputFiles({ name: 'kim-front.jpg', mimeType: 'image/jpeg', buffer: TINY_JPEG })
    await expect(imageSection(page).locator('img')).toHaveCount(1)

    // Everything required is present: the button goes live and both
    // explanations (reason line + tooltip) disappear rather than go stale.
    await expect(submit(page)).toBeEnabled()
    await expect(blockerLine(page)).toHaveCount(0)
    await expect(submit(page)).not.toHaveAttribute('title', /./)
  })
})

// ── A continuation's summary card ────────────────────────────────────────────
//
// vf-open loads collapsed behind the "carried from v1" summary card with a
// fully valid inheritance, so Save starts ENABLED. The card is where a
// collapsed form must surface its blockers: a designer who never expands the
// form would otherwise face a greyed Save with the reason hidden inside a
// section they can't see (the exact case the saveBlockerItems list on the
// card exists for — including the wizard gate, which the field-level
// validations never report).

test.describe('save gating on a continuation (vf-open)', () => {
  test('reopening the wizard blocks Save and grows a blocker list on the summary card, live both ways', async ({ page }) => {
    await page.goto('/verify-harness/index.html?path=/proofs/vf-open/versions/new')
    const edit = page.getByRole('button', { name: /edit details/i })
    await expect(edit).toBeVisible()

    // A valid continuation: enabled Save, no reason line, no bullets on the
    // summary card (the section carrying the inherited-values <dl>).
    const summary = page.locator('section').filter({ has: page.locator('dl') }).first()
    await expect(submit(page)).toBeEnabled()
    await expect(blockerLine(page)).toHaveCount(0)
    await expect(summary.locator('ul > li')).toHaveCount(0)

    // Reopen the proof-type question: the shape is now unresolved, which is
    // a save blocker in its own right — the button locks, the reason line
    // appears, and the summary card grows exactly one bullet for it.
    await edit.click()
    await page.getByRole('button', { name: /^change$/i }).first().click()
    await expect(page.locator(FAMILY)).toHaveCount(3)
    await expect(submit(page)).toBeDisabled()
    await expect(blockerLine(page)).toBeVisible()
    await expect(summary.locator('ul > li')).toHaveCount(1)

    // Re-answering resolves the shape again and every signal stands down —
    // the list is a live derivation, not a latch.
    await answer(page, FAMILY, 'recipients')
    await expect(submit(page)).toBeEnabled()
    await expect(blockerLine(page)).toHaveCount(0)
    await expect(summary.locator('ul > li')).toHaveCount(0)
  })
})

// ── Who is each QR code for? ────────────────────────────────────────────
//
// A QR row with no recipient means "shared": the same code prints on every
// card. A hand-dropped code used to default to exactly that, silently, and
// it reached a customer — TKO Marketing's v2 carried one personal LinkedIn
// code per director, all three left shared, so the proof page showed all
// three under all three names and each director approved with a note saying
// which was actually theirs.
//
// The failures these catch:
//   * a fresh QR that arrives already reading "All recipients" is an answer
//     nobody gave, and the whole defect ships again;
//   * a blocker that survives a real choice (or a picker that can't be
//     satisfied) makes the form unsaveable, which is worse than the bug;
//   * "All recipients (shared)" must stay a ONE-CLICK valid answer — one
//     company website on everybody's card is the ordinary case, and a rule
//     that fought it would be turned off within a week.
//
// vf-open is a two-recipient continuation, so the picker is live on it.
test.describe('QR recipient gate (vf-open)', () => {
  // Real QR pixels: the form decodes the file client-side and rejects
  // anything it can't read, so a placeholder image would never become an
  // entry. Declared as image/jpeg to satisfy the input's accept filter —
  // the decoder sniffs the actual bytes, so the PNG payload is fine.
  async function qrFile(text: string, name: string) {
    const QRCode = (await import('qrcode')).default
    return { name, mimeType: 'image/jpeg', buffer: await QRCode.toBuffer(text, { width: 320, margin: 2 }) }
  }

  const qrSection = (page: Page) =>
    page.locator('section').filter({ has: page.getByRole('heading', { name: /^qr codes$/i }) })
  const appliesTo = (page: Page) => qrSection(page).locator('select')

  test('a dropped QR blocks Save until somebody says who it is for', async ({ page }) => {
    await page.goto('/verify-harness/index.html?path=/proofs/vf-open/versions/new')
    // The fixture starts valid — so any blocking below is this rule's doing.
    await expect(submit(page)).toBeEnabled()

    await qrSection(page)
      .locator('input[type="file"]')
      .setInputFiles(await qrFile('https://example.test/asha', 'qr-asha.jpg'))

    // The picker arrives with NO selection — the placeholder is the point.
    await expect(appliesTo(page)).toHaveCount(1)
    await expect(appliesTo(page)).toHaveValue('')
    await expect(appliesTo(page)).toHaveAttribute('aria-invalid', 'true')

    // And the door is shut, with the reason printed beside the button.
    await expect(submit(page)).toBeDisabled()
    await expect(blockerLine(page)).toBeVisible()

    // Naming an owner clears it live, with no save attempt in between.
    await appliesTo(page).selectOption('Asha Rao')
    await expect(appliesTo(page)).not.toHaveAttribute('aria-invalid', 'true')
    await expect(submit(page)).toBeEnabled()
    await expect(blockerLine(page)).toHaveCount(0)
  })

  test('"All recipients" is a valid answer, and the set-level advisory never blocks', async ({ page }) => {
    await page.goto('/verify-harness/index.html?path=/proofs/vf-open/versions/new')
    await qrSection(page)
      .locator('input[type="file"]')
      .setInputFiles([
        await qrFile('https://example.test/asha', 'qr-one.jpg'),
        await qrFile('https://example.test/ben', 'qr-two.jpg'),
      ])
    await expect(appliesTo(page)).toHaveCount(2)
    await expect(submit(page)).toBeDisabled()

    // Two distinct codes, both deliberately shared, on a two-name version:
    // the shape worth mentioning. Deliberately chosen, so Save opens — the
    // advisory is a nudge and must never become a second blocker.
    await appliesTo(page).nth(0).selectOption('__shared__')
    await appliesTo(page).nth(1).selectOption('__shared__')
    await expect(submit(page)).toBeEnabled()
    await expect(blockerLine(page)).toHaveCount(0)
    await expect(page.getByTestId('qr-shared-warning')).toBeVisible()

    // Give one of them an owner and the shape no longer reads as
    // one-code-each, so the advisory stands down.
    await appliesTo(page).nth(0).selectOption('Asha Rao')
    await expect(page.getByTestId('qr-shared-warning')).toHaveCount(0)
    await expect(submit(page)).toBeEnabled()
  })
})

// ── Which side is this? ─────────────────────────────────────────────────
//
// The edit form's per-image controls stack two dropdowns. The top one is
// the recipient, whose blank reads "Shared" — a real, meaningful value.
// Directly under it sat Side, whose blank read "—" and meant nothing was
// recorded. Two identical-looking empties, one a decision and one a hole.
//
// The hole filled itself: matchImageToName returns a null side whenever
// the filename carries no front/back token, so a designer hand-tagged
// the files they noticed and one slipped through. That is how The
// Sourdough Company's approved, ordered proof reached its customer with
// two cards reading FRONT / BACK and the third reading FRONT / nothing.
//
// What these catch:
//   * a blank offered as a CHOICE on a two-sided version is the bug
//     itself — the state must be un-pickable, only inheritable;
//   * a Save that goes through with a side unanswered ships the same
//     proof again;
//   * and on a ONE-sided version the question must not be asked at all,
//     because an unlabelled image can only be the front there and both
//     the customer page and the artwork hand-off already read it so.
//     A check that nags where there is no answer to get gets ignored.
test.describe('side is answered before saving (vf-sides)', () => {
  const sideSelects = (page: Page) => page.locator('select[aria-label="Side"]')
  // The edit form renders its Cancel + Save pair twice (beside the heading
  // and again below the image grid), so the shared `submit` helper is
  // ambiguous here.
  const save = (page: Page) => page.locator('button[type="submit"]').first()

  test('an unlabelled image on a two-sided set blocks Save, and the blank cannot be chosen', async ({ page }) => {
    await page.goto('/verify-harness/index.html?path=/proofs/vf-sides/versions/vf-sides-v1/edit')
    await expect(sideSelects(page)).toHaveCount(3)

    // The one nobody labelled: empty value, and its blank option is
    // present only to render that state — never selectable.
    const unset = sideSelects(page).filter({ has: page.locator('option[value=""]') })
    await expect(unset).toHaveCount(1)
    await expect(unset).toHaveValue('')
    await expect(unset).toHaveAttribute('aria-invalid', 'true')
    await expect(unset.locator('option[value=""]')).toHaveAttribute('disabled', '')

    // The two that ARE labelled offer no blank at all.
    await expect(sideSelects(page).locator('option[value=""]')).toHaveCount(1)

    // Saving with it outstanding is refused, and the form says so.
    await save(page).click()
    await expect(page.getByRole('status')).toBeVisible()

    // Answering it clears the state live.
    await unset.selectOption('back')
    await expect(sideSelects(page).locator('option[value=""]')).toHaveCount(0)
    await expect(sideSelects(page).nth(2)).not.toHaveAttribute('aria-invalid', 'true')
  })

  test('a one-sided set is never asked, because front is the only answer', async ({ page }) => {
    // vf-open carries two fronts and no back.
    await page.goto('/verify-harness/index.html?path=/proofs/vf-open/versions/vf-open-v1/edit')
    await expect(sideSelects(page)).toHaveCount(2)
    await expect(sideSelects(page).locator('[aria-invalid="true"]')).toHaveCount(0)
    await expect(save(page)).toBeEnabled()
  })
})
