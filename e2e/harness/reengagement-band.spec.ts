// The re-engagement welcome band on the customer proof page (000389 / 000392).
//
// Runs against the verify harness with the cp- fixture module
// (verify-harness/fixtures/customer-proof.ts), against a matched PAIR of
// fixtures that differ in exactly one field: cp-reengage's order-state RPC
// carries a `reengagement` snapshot, cp-basic's does not.
//
// What this exists to catch, in order of how badly it would hurt:
//
//   1. The band appearing on an ORDINARY proof. That customer commissioned
//      the work and has been waiting for it; greeting them with "welcome
//      back — nothing here is new" about artwork they have never seen is
//      both wrong and insulting. The snapshot rides the same payload as the
//      order state, so a parse or gating regression could switch it on for
//      everyone at once — which is why the negative case gets its own test
//      and its own independent assertions.
//
//   2. The band vanishing on an outreach proof. The Reorder desk's whole
//      pitch is the recognition line; without it the page interrogates a
//      past customer about a design they approved years ago.
//
//   3. The band losing an action, or growing the wrong one. The two openings
//      and the exit are someone's only easy way forward, and a dropped one
//      removes an option silently rather than breaking anything visibly. The
//      inverse matters more: this page must never be able to APPROVE on v1 —
//      a press marks the register "Ordered again" with no order in existence
//      and drops the customer out of every follow-up bucket for good. So the
//      absence of that button is asserted as hard as the presence of the rest.
//
//   4. A MARKER ON THE WRONG THING. The band says what they last bought; the
//      price grid and the thickness guide point at it. A tint down the wrong
//      column, or a "Your last order" chip on a customer who has never
//      ordered, is a confident claim about their own history that is false —
//      which costs more than the markers gain. So the tests below check where
//      the markers land, and that an ordinary proof carries none at all.
//      Located by the `data-previous-order` attribute the page stamps on each
//      one, since a chip has no role of its own and its wording is copy.
//
// ⚠ Assert STRUCTURE, never wording. The band is located by its aria wiring
// (the region labelled by its own heading), so every assertion below survives
// a copy rewrite. It used to be found as "the only region with a tick-list",
// until the tick-list was cut for implying a report that was never filed.

import { test, expect, type Page } from '@playwright/test'

// Console capture must be attached BEFORE goto so a render error during
// hydration is not missed. The page holds a ~2.8s minimum loading animation,
// so landmark waits rely on the 7s expect timeout.
function captureRenderErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error' && msg.text().includes('[harness] uncaught render error')) {
      errors.push(msg.text())
    }
  })
  return errors
}

// The band is the region labelled by its own heading. Role + the aria
// contract, so no copy is pinned and a band that lost its labelling — which
// would strand a screen-reader user in an unnamed region — fails here too.
function band(page: Page) {
  return page.getByRole('region').filter({ has: page.locator('#reengage-heading') })
}

test.describe('re-engagement band', () => {
  test('an outreach proof opens with the band, and it renders whole', async ({ page }) => {
    const errors = captureRenderErrors(page)
    await page.goto('/verify-harness/index.html?path=/p/cp-reengage')

    // The page itself landed (fixture company in the masthead) before
    // anything is claimed about the band.
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Feld & Rowe')

    const b = band(page)
    await expect(b).toHaveCount(1)

    // A labelled region needs a heading to label it — the aria wiring is the
    // point, not the words in it.
    await expect(b.getByRole('heading', { level: 2 })).toHaveCount(1)

    // No tick-list: it was cut because ticks that reach nobody imply a report
    // that is never filed. Its content is now the hint under the request
    // form's note field, whose QR-conditional wording is unit-tested where it
    // costs no page load.
    await expect(b.getByRole('checkbox')).toHaveCount(0)

    // The remembered purchase is spoken, because the fixture's spec matches
    // the fixture's material. This is the sentence the whole enrichment
    // exists for, and without a fixture carrying last_spec it had no
    // coverage at all — deleting the spec branch would have stayed green.
    await expect(b).toContainText('250 stainless steel cards (500 micron)')

    // Three ways forward: the buying route, the new-joiner route (a repeat
    // customer's likeliest real need, which they'd never think to call
    // "updating"), and the subordinate exit. Counted rather than named so the
    // labels stay free to change — but counted, because a dropped one removes
    // someone's only easy way forward without breaking anything visibly.
    await expect(b.getByRole('button')).toHaveCount(3)

    expect(errors).toEqual([])
  })

  test('both openings lead to ONE request form, prefilled for what was pressed', async ({
    page,
  }) => {
    // Two doors, one room. The band used to point both of its actions at the
    // page's own Request-changes button — the same destination twice, and no
    // route at all for "yes, more please", which is the answer the whole
    // outreach exists to collect.
    //
    // ⚠ ONE form is structural, not cosmetic: claim_reorder_request is a
    // single-row claim with a 24-hour cooldown in its own WHERE, so two
    // buttons posting two claims would mean the second lands inside the window,
    // loses, and is answered with the same cheerful acknowledgement while the
    // customer's words go nowhere.
    await page.goto('/verify-harness/index.html?path=/p/cp-reengage-thick')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Rowe Metalworks')

    const b = band(page)
    const repeat = b.getByRole('button').first()
    const newPerson = b.getByRole('button').nth(1)

    // The buying door opens a form with their own last quantity already in it.
    // Typing a number on a phone is exactly where a mildly-interested visitor
    // gives up, and 250 is fixture data — not a default that would look right
    // by accident.
    await repeat.click()
    const qty = b.getByLabel(/quantity/i)
    await expect(qty).toHaveValue('250')
    const note = b.getByLabel(/anything changed/i)
    await expect(note).toHaveValue('')
    // No dialog: the band collects in place. It never opens the approval
    // panel, whose slot key differs per proof shape and whose wrong guess
    // loses what the customer typed.
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Back returns to the openings rather than stranding them in a form they
    // opened by mistake.
    await b.getByRole('button', { name: /^back$/i }).click()
    await expect(b.getByLabel(/quantity/i)).toHaveCount(0)

    // The new-joiner door reaches the SAME form, differing only in the prompt.
    // Naming the three fields is the entire reason it is a separate door.
    await newPerson.click()
    await expect(b.getByLabel(/quantity/i)).toHaveValue('250')
    const prefill = await b.getByLabel(/anything changed/i).inputValue()
    expect(prefill.toLowerCase()).toContain('name')
    expect(prefill.toLowerCase()).toContain('job title')
    expect(prefill.toLowerCase()).toContain('contact details')
  })

  test('the band can ask but never buy, and says so', async ({ page }) => {
    // The house rule for /p/ (000367 / 000372): a link with no token, handed
    // around by team sharing, may carry facts and requests and no capability.
    // The reassurance is the boundary stated to the customer in as many words.
    await page.goto('/verify-harness/index.html?path=/p/cp-reengage-thick')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Rowe Metalworks')

    const b = band(page)
    await b.getByRole('button').first().click()

    await expect(b).toContainText(/nothing has been ordered/i)
    await expect(b).toContainText(/nothing is being printed/i)
    // No link out of the band at all — a pay link is the one thing on this
    // page that would let a link-holder spend the customer's money.
    await expect(b.getByRole('link')).toHaveCount(0)
  })

  test('a customer who already asked is told so, and never asked again', async ({ page }) => {
    // ⚠ The failure this exists to stop: a customer we cold-approached does
    // the thing we asked, comes back, and is shown the same "Order these
    // again" — which reads as "they ignored me", the worst outcome available
    // to a re-engagement page. In-session state can't cover it (a reload, a
    // second tab, a colleague on the shared link), so the acknowledgement is
    // read from the SERVER's own stamp — reachable on an order-less proof only
    // because 000401 hoisted it out of the order-shaped payload.
    await page.goto('/verify-harness/index.html?path=/p/cp-reengage-asked')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Raval & Co')

    const b = band(page)
    await expect(b).toHaveCount(1)
    await expect(b.locator('[data-reengage-ack]')).toHaveCount(1)
    // No openings, no form, no exit — nothing to press, because there is
    // nothing left for them to tell us.
    await expect(b.getByRole('button')).toHaveCount(0)
  })

  test('an outreach v1 offers no Approve — the register would call it a sale', async ({
    page,
  }) => {
    // ⚠ The single most consequential assertion in this file. Approve is the
    // page's most prominent control, and on an outreach proof
    // syncProspectOutcomes flips the prospect to state='converted' — rendered
    // "Ordered again" in green — off proofs.status === 'approved' ALONE, with
    // no order in existence. That permanently removes the customer from every
    // follow-up, quiet-close and reply bucket while emailing them that we'll
    // be in touch about next steps.
    //
    // Request changes is deliberately NOT suppressed: it means what it says
    // here, and it is the honest fallback if the band's form fails.
    await page.goto('/verify-harness/index.html?path=/p/cp-reengage')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Feld & Rowe')

    const actions = page.locator('[data-proof-actions]')
    await expect(actions).not.toHaveCount(0)
    await expect(actions.getByRole('button', { name: /^approve/i })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /request changes/i })).toHaveCount(1)
  })

  test('an ORDINARY proof keeps its Approve button', async ({ page }) => {
    // The negative twin of the test above, and the one that matters most if
    // the gate ever loosens: suppressing Approve on a normal proof would break
    // the primary flow of the entire product for every customer at once.
    await page.goto('/verify-harness/index.html?path=/p/cp-basic')

    const approve = page.getByRole('button', { name: /^approve/i })
    await expect(approve).not.toHaveCount(0)
  })

  test('the quantity they bought is marked in the grid, and the thickness in the guide', async ({
    page,
  }) => {
    // cp-reengage is a single-column proof — one priced variant, the shape
    // ~160 live versions have (paper, wood, acrylic, carbon fibre). There is
    // no thickness column to point at, so the quantity row is the ONLY marker
    // the grid can carry, and it has to work here or the feature reaches
    // almost nobody.
    await page.goto('/verify-harness/index.html?path=/p/cp-reengage')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Feld & Rowe')

    const qtyMarker = page.locator('[data-previous-order="quantity"]')
    await expect(qtyMarker).toHaveCount(1)
    // On the row for the quantity the fixture says they ordered — not merely
    // present somewhere on the page. The number is fixture data, not copy.
    await expect(qtyMarker.locator('xpath=ancestor::td[1]')).toContainText('250')

    // The thickness guide is the one surface that describes what a thickness
    // FEELS like, which is what someone re-ordering wants confirming.
    const guideMarker = page.locator('[data-previous-order="thickness-guide"]')
    await expect(guideMarker).toHaveCount(1)
    await expect(guideMarker.locator('xpath=ancestor::div[1]')).toContainText('500µm')
  })

  test('the column they bought is badged — and only that one', async ({ page }) => {
    // cp-reengage-thick prices two thicknesses, which is what puts the grid on
    // its multi-column path. The fixture's remembered purchase is the SECOND
    // column, so a marker that quietly defaults to the first would fail here
    // rather than accidentally looking right.
    await page.goto('/verify-harness/index.html?path=/p/cp-reengage-thick')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Rowe Metalworks')

    const headers = page.getByRole('columnheader')
    await expect(headers).toHaveCount(3) // Quantity + two thicknesses

    const badge = page.locator('[data-previous-order="thickness"]')
    await expect(badge).toHaveCount(1)
    const badgedHeader = badge.locator('xpath=ancestor::th[1]')
    await expect(badgedHeader).toContainText('500 micron')
    await expect(badgedHeader).not.toContainText('300 micron')

    // Deliberately NO column wash: a fill behind eleven rows of prices is a
    // large filled area at chip strength, it never aligns with the cell
    // padding, and it tells a screen reader nothing. The badge is the signal,
    // so the price cells must stay as plain as their neighbours.
    const row = page.getByRole('row').filter({ hasText: '250' }).first()
    const cells = row.getByRole('cell')
    const badgedCell = await cells.nth(2).evaluate((el) => getComputedStyle(el).backgroundColor)
    const plainCell = await cells.nth(1).evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(badgedCell).toBe(plainCell)

    // And the quantity marker still lands, so the two together read as "you
    // had 250 of the 500 micron".
    await expect(page.locator('[data-previous-order="quantity"]')).toHaveCount(1)
  })

  test('an ink-count grid is never narrated as though it showed thicknesses', async ({ page }) => {
    // ⚠ THE 822-ROW BUG, end to end. Translucent Plastic, Satin Plastic and
    // Letterpress are priced per ink, so cp-reengage-inks' columns read "2
    // Inks" / "3 Inks" — there is no thickness anywhere on this page. The
    // remembered purchase is a 760µm plastic card the catalogue has since
    // retired, and the page used to read "we know the label, we can't find the
    // column" as not-available and print "…the thicknesses above are the
    // current options" underneath a grid of ink counts.
    await page.goto('/verify-harness/index.html?path=/p/cp-reengage-inks')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Vance Optics')
    await expect(band(page)).toHaveCount(1)

    // The grid really is columned by ink count — otherwise this test proves
    // nothing about the dimension it exists to protect.
    const headers = page.getByRole('columnheader')
    await expect(headers).toHaveCount(3) // Quantity + two ink counts
    await expect(headers.nth(1)).toContainText('Inks')

    // Nothing may be said about those columns, and none may be badged.
    await expect(page.locator('[data-previous-order="thickness-note"]')).toHaveCount(0)
    await expect(page.locator('[data-previous-order="thickness"]')).toHaveCount(0)

    // …but the quantity row keeps its marker. It is a number of cards, which
    // means the same thing whatever the columns are — and on a grid with no
    // thickness to point at it is the ONLY marker, so silencing it would take
    // the feature away from exactly the customers the bug was hurting.
    const qtyMarker = page.locator('[data-previous-order="quantity"]')
    await expect(qtyMarker).toHaveCount(1)
    await expect(qtyMarker.locator('xpath=ancestor::td[1]')).toContainText('250')
  })

  test('a curated grid and the thickness guide never contradict each other', async ({ page }) => {
    // cp-reengage-curated prices only the 300µm column (displayed_variant_ids),
    // while the customer last bought 500µm. The grid says so plainly. The guide
    // sits a few centimetres away on the same screen and used to decide
    // separately — parsing microns out of the remembered label, never
    // consulting the ids the grid renders — so it badged "500µm · Your last
    // order" directly beside the sentence ruling that thickness out.
    await page.goto('/verify-harness/index.html?path=/p/cp-reengage-curated')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Blake Instruments')

    // The grid is the surface explaining the absence…
    await expect(page.locator('[data-previous-order="thickness-note"]')).toHaveCount(1)

    // …so the guide, which is genuinely on screen for this metal proof, must
    // carry no badge at all.
    await expect(page.getByRole('heading', { name: /thickness/i })).toBeVisible()
    await expect(page.locator('[data-previous-order="thickness-guide"]')).toHaveCount(0)

    // The quantity marker is unaffected by any of it.
    await expect(page.locator('[data-previous-order="quantity"]')).toHaveCount(1)
  })

  test('an ordinary proof gets no band at all', async ({ page }) => {
    // THE regression this file exists for. cp-basic is identical in shape to
    // cp-reengage bar the one field, so a gate that stopped reading the
    // snapshot — or a parser that let a malformed one through as truthy —
    // would light this up for a customer who asked for their proof.
    const errors = captureRenderErrors(page)
    await page.goto('/verify-harness/index.html?path=/p/cp-basic')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Kite & Co')

    await expect(band(page)).toHaveCount(0)
    // Independent of how the band is located: its heading anchor is absent
    // entirely, so a band rendered without its region wrapper still fails.
    await expect(page.locator('#reengage-heading')).toHaveCount(0)

    // The ordinary opening survives — the decision surface is still the
    // page's first offer, which is what the band would have replaced.
    await expect(page.getByRole('button', { name: /approve priya/i })).toBeVisible()

    // …and no marker of any kind. Two failures are covered here at once: a
    // "Your last order" chip for someone who has never ordered, and the
    // shared thickness catalogue's own "Most popular" badge, which this page
    // has never shown and must not start showing — the designer already chose
    // the thickness, so a recommendation here second-guesses them in front of
    // the customer. cp-basic is a metal proof, so the guide really is on
    // screen for that to be a meaningful absence.
    await expect(page.locator('[data-previous-order]')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: /thickness/i })).toBeVisible()

    expect(errors).toEqual([])
  })
})
