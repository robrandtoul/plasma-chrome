// Designer notes as the customer sees them (migration 000347).
//
// These run against the REAL customer page and the REAL anon read path, on the
// Atari Corp steel fixture — not a real customer, so loading it is harmless.
//
// Every assertion here corresponds to something that actually went wrong or that
// must never go wrong:
//
//   1. the strip appears at all (it didn't, because the code wasn't deployed and
//      the gate was off — both invisible to type-checking)
//   2. the ARTWORK IS NEVER MARKED on the overview — the rule the whole design
//      rests on, and the one a future refactor is most likely to break
//   3. a marker sits exactly on its stored coordinate, not offset from it (this
//      shipped wrong: markers were displaced 4%, so they missed what they pointed
//      at and would have had designers aiming off-target to compensate)

import { test, expect } from '@playwright/test'

// The steel fixture. It carries at least one designer note.
//
// ⚠ Assert STRUCTURE, never note wording. This fixture is shared with humans —
// staff write, edit and delete notes on it while demoing, and an early version
// of this spec matched seeded text that Rob had since replaced with his own.
// Every check below holds for any note content, so the suite survives the
// fixture being used.
const PROOF_ID = 'b7d0796e-c7a5-44d1-860c-e39f92730521'

test.describe('designer notes on the customer proof page', () => {
  test.beforeEach(async ({ page }) => {
    // ?preview=1 skips record_proof_view — without it every local run records a
    // real customer view on the shared fixture, feeding the needs-attention
    // rules and waking snoozes. See src/lib/customerProofUrl.ts.
    await page.goto(`/p/${PROOF_ID}?preview=1`)
    // The page resolves its payload through an anon RPC, so wait for real
    // content rather than load state.
    await expect(page.getByText('Atari Corp').first()).toBeVisible()
  })

  test('the note strip appears OPEN, naming the designer', async ({ page }) => {
    const strip = page.getByRole('button', { name: /notes? from Rob/i })
    await expect(strip).toBeVisible()
    // Expanded by default. It began life collapsed and Rob's verdict on seeing it
    // was that a customer would miss it entirely — a note nobody reads is worse
    // than no note. Collapsing is still possible, just not the default.
    await expect(strip).toHaveAttribute('aria-expanded', 'true')
    // Something is actually readable, whatever it says.
    await expect(page.getByRole('img', { name: /detail of the area/i }).first()).toBeVisible()
  })

  test('the notes sit ABOVE the approve decision, not below it', async ({ page }) => {
    // The bug this locks in: the strip used to render after the action band, so
    // a customer who scrolled to Approve and pressed it never saw the notes. They
    // exist to inform that decision, so they must come before it.
    const strip = page.getByRole('button', { name: /notes? from Rob/i })
    const approve = page.getByRole('button', { name: /^Approve/i }).first()
    await expect(strip).toBeVisible()
    await expect(approve).toBeVisible()

    const stripBox = await strip.boundingBox()
    const approveBox = await approve.boundingBox()
    expect(stripBox).not.toBeNull()
    expect(approveBox).not.toBeNull()
    expect(stripBox!.y).toBeLessThan(approveBox!.y)
  })

  test('each note carries a cropped detail of its own area', async ({ page }) => {
    // One crop per note, whatever the notes say. The crop is the SAME image
    // scaled up and positioned on the note's anchor — no second file is fetched.
    const crops = page.getByRole('img', { name: /detail of the area/i })
    const noteLinks = page.getByRole('button', { name: /view on the card/i })
    await expect(crops.first()).toBeVisible()
    expect(await crops.count()).toBe(await noteLinks.count())

    const style = await crops.first().evaluate((el) => {
      const s = getComputedStyle(el)
      return { size: s.backgroundSize, position: s.backgroundPosition, image: s.backgroundImage }
    })
    expect(style.image).toContain('url(')
    // 3.3x zoom. The position is the note's own stored fraction, so it is read
    // rather than hardcoded — a spec pinned to seeded numbers goes stale the
    // moment anyone adds a version (which is exactly how these tests first
    // failed).
    // Engine-agnostic: WebKit serialises this as "330% auto", Chromium as
    // "330%". Same rendering, different computed-style string — assert the
    // horizontal component only.
    expect(style.size.split(' ')[0]).toBe('330%')
    expect(style.position).toMatch(/^\d+(\.\d+)?% \d+(\.\d+)?%$/)
  })

  test('THE RULE: no marker is ever drawn on the artwork in the overview', async ({ page }) => {
    // The overview is the surface that sells the card. If this fails, the
    // feature is doing the one thing it promised never to do — even if
    // everything else still works.
    await expect(page.getByRole('button', { name: /notes? from Rob/i })).toBeVisible()
    await expect(page.getByRole('img', { name: /detail of the area/i }).first()).toBeVisible()
    // The notes are on screen and readable, and STILL nothing is drawn on the
    // artwork. Visibility and a clean card are not in tension.
    await expect(page.locator('[aria-label^="Note "]')).toHaveCount(0)
  })

  test('a marker in the zoom view sits exactly on its stored coordinate', async ({ page }) => {
    // Read the anchor from the crop the customer is looking at, so the check is
    // self-consistent: whatever fraction the note stores, the dot must land on
    // that same fraction of the artwork.
    const anchor = await page
      .getByRole('img', { name: /detail of the area/i })
      .first()
      .evaluate((el) => {
        const pos = getComputedStyle(el).backgroundPosition.split(' ')
        return { fx: parseFloat(pos[0]) / 100, fy: parseFloat(pos[1]) / 100 }
      })

    await page.getByRole('button', { name: /view on the card/i }).first().click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    const img = dialog.locator('img').first()
    await expect(img).toBeVisible()

    // Compare the marker's centre against the point the stored fraction names
    // on the rendered image. This is the assertion that would have caught the
    // 4% offset that shipped.
    const geometry = await img.evaluate(
      (el, { fx, fy }) => {
        const r = el.getBoundingClientRect()
        const dots = Array.from(
          el.closest('div')?.querySelectorAll('span[aria-hidden="true"]') ?? [],
        )
          .map((d) => d.getBoundingClientRect())
          .filter((d) => d.width > 8 && d.width < 40)
        return {
          expected: { x: r.left + r.width * fx, y: r.top + r.height * fy },
          dots: dots.map((d) => ({ x: d.left + d.width / 2, y: d.top + d.height / 2 })),
        }
      },
      anchor,
    )

    expect(geometry.dots.length).toBeGreaterThan(0)
    const nearest = geometry.dots.reduce((best, d) => {
      const dist = Math.hypot(d.x - geometry.expected.x, d.y - geometry.expected.y)
      return dist < best.dist ? { dist, d } : best
    }, { dist: Infinity, d: geometry.dots[0] })

    // 2px of slack for sub-pixel rounding only. The bug this guards against was
    // ~17px out, so anything approaching the old behaviour fails loudly.
    expect(nearest.dist).toBeLessThan(2)
  })
})
