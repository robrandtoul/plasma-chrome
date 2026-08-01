// Tier 3 synthetic check: can a customer actually SEE their artwork?
//
// Runs a real browser against PRODUCTION from GitHub Actions, on deploy and
// every two hours. See playwright.prod.config.ts for why this is a separate
// config, and .github/workflows/proof-view-check.yml for the deploy-timing
// guard.
//
// WHY THIS EXISTS
// ---------------
// public/_redirects ends with `/*  /index.html  200`. Every URL on
// proofs.plasmadesign.co.uk therefore answers 200 with the SPA shell, so all
// four of these break the customer page while every HTTP monitor stays green:
//
//   • a React bundle that throws on mount
//   • a dead customer-proof-images edge function (no signed image URLs)
//   • a changed public_get_customer_proof shape
//   • a Netlify build carrying a stale VITE_SUPABASE_ANON_KEY
//
// Each assertion below maps to one of those. None of them is decoration.
//
// TWO RULES THIS FILE MUST KEEP
// -----------------------------
// 1. IT WRITES NOTHING. The page is opened with ?preview=1, which makes
//    CustomerProofPage skip the record_proof_view RPC (see the designer-preview
//    bypass there). Without it every run would record a GENUINE non-bot view —
//    record_proof_view's bot allow-list is deliberately tight and matches no
//    Playwright user-agent — inflating view counts, feeding needs-attention
//    rules and auto-waking sent_never_viewed snoozes (000220).
//
//    Verified, not assumed: ?preview=1 changes ONLY view recording. The three
//    preview-bridge effects in CustomerProofPage all gate on isEmbeddedPreview(),
//    which additionally requires window.parent !== window; Playwright loads the
//    page top-level, so they no-op. Nothing else on /p/:id reads the flag.
//
// 2. IT CLICKS NOTHING. The customer page carries several anon-writable
//    actions — approve, request changes, decline feedback, "ask us", and the
//    reorder request, which opens a real Help Scout conversation. This asserts
//    on rendered state only. Do not add a click here.

import { test, expect, type Page } from '@playwright/test'

// The fixture is identified by env, not by literal, because a proof id is a
// bearer capability: /p/:id has no token, so anyone holding the id can read
// the proof. It stays out of the repo even for a fake company.
const PROOF_ID = process.env.PROOF_VIEW_PROOF_ID ?? ''

// Fixture identity. Atari Corp / Nolan Bushnell is the standing test customer
// (see CLAUDE.md) — a fake company with a non-deliverable @example.com address,
// no Help Scout thread and auto-nudges disabled. Never point this at a real
// customer: loading their proof is a real event in their project.
const EXPECT_COMPANY = process.env.PROOF_VIEW_COMPANY ?? 'Atari Corp'
const EXPECT_CONTACT = process.env.PROOF_VIEW_CONTACT ?? 'Nolan Bushnell'

// Artwork is served as SIGNED Supabase storage URLs, minted per request by the
// customer-proof-images edge function. Matching on that path rather than on a
// CSS class is both more robust and more meaningful: it is precisely the
// "storage + edge function worked" assertion.
//
// ⚠ Do NOT loosen this to a bare `img`. The masthead logo is a same-origin
// <img> that loads fine even when every piece of Supabase is down, so a bare
// selector would make this whole check pass vacuously — the exact blindness it
// was written to remove.
const ARTWORK = 'img[src*="/storage/v1/object/sign/"]'

/** Terminal screens that mean "the fixture is no longer usable", each with the
 *  fix rather than a generic assertion failure. Getting this wrong costs a
 *  confusing 3am page, so the message does the explaining. */
const TERMINAL_SCREENS: { text: string; why: string }[] = [
  {
    text: 'This proof is closed',
    why:
      'the fixture proof has been ABANDONED, so the page renders the closed card and no artwork. ' +
      'This is not a production outage. Restore it (status back to approved) or repoint ' +
      'PROOF_VIEW_PROOF_ID at another Atari Corp fixture.',
  },
  {
    text: 'Not found',
    why:
      'the proof id was not found. Either PROOF_VIEW_PROOF_ID is wrong, or the fixture proof ' +
      'was deleted. This is not a production outage.',
  },
  {
    text: 'Something went wrong on this page',
    why:
      'the React error boundary caught a render crash. THIS IS A REAL FAILURE — the bundle is ' +
      'broken in production. Open the trace artifact and the browser console output.',
  },
]

async function bodyText(page: Page): Promise<string> {
  return (await page.locator('body').innerText().catch(() => '')) || ''
}

test.describe('customer proof view (production)', () => {
  test('a customer can load their proof and see the artwork', async ({ page }) => {
    // A monitor that quietly skips is a monitor that is not running. Fail.
    expect(
      PROOF_ID,
      'PROOF_VIEW_PROOF_ID is not set. This check cannot run without a fixture proof id; ' +
        'set the repo secret (gh secret set PROOF_VIEW_PROOF_ID).',
    ).not.toBe('')

    // ── Collect evidence while the page loads ────────────────────────────
    // A stale or rotated VITE_SUPABASE_ANON_KEY is invisible to every HTTP
    // monitor: Netlify still serves 200, the shell still renders, and only the
    // browser's own calls to Supabase come back 401. This listener is the only
    // thing in the whole monitoring stack that can see that.
    const supabaseFailures: string[] = []
    page.on('response', (res) => {
      const url = res.url()
      if (!url.includes('.supabase.co/')) return
      if (res.status() < 400) return
      // Strip the query string: signed storage URLs carry a token, and this
      // string ends up in CI logs and the uploaded artifact.
      supabaseFailures.push(`${res.status()} ${res.request().method()} ${url.split('?')[0]}`)
    })

    // Uncaught exceptions from the bundle. A page can look fine and still have
    // thrown — this catches the half-broken deploy.
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    // ?preview=1 — see rule 1 at the top of this file.
    await page.goto(`/p/${PROOF_ID}?preview=1`, { waitUntil: 'domcontentloaded' })

    // ── 1. The payload resolved ──────────────────────────────────────────
    // Hard assertion, and deliberately first: everything below is meaningless
    // if the anon RPC never returned. Proves public_get_customer_proof answered
    // with real data rather than the page rendering an empty shell.
    await expect(
      page.getByRole('heading', { name: EXPECT_COMPANY }).first(),
      `The proof payload never rendered. Either the app bundle failed to boot, or ` +
        `public_get_customer_proof did not return data for this proof.`,
    ).toBeVisible()

    // ── 2. Not a terminal screen ─────────────────────────────────────────
    // Checked BEFORE artwork, because the closed card also shows the company
    // name — so without this, an abandoned fixture would fail later with a
    // misleading "no artwork found" instead of naming the real cause.
    const text = await bodyText(page)
    for (const screen of TERMINAL_SCREENS) {
      expect(text, `Page shows "${screen.text}" — ${screen.why}`).not.toContain(screen.text)
    }

    // ── 3. The artwork actually loaded ───────────────────────────────────
    // The assertion the whole check exists for. `complete && naturalWidth > 0`
    // is the part that matters: a broken-image icon is still a visible <img>
    // with a src, so presence alone would pass while the customer sees nothing.
    const artwork = page.locator(ARTWORK)
    await expect(
      artwork.first(),
      'No signed Supabase storage image on the page. The customer-proof-images edge function ' +
        'is the usual cause — it mints the signed URLs, and without it the customer sees a ' +
        'proof page with no proof on it.',
    ).toBeVisible()

    await expect
      .poll(
        () =>
          artwork
            .first()
            .evaluate((el) => {
              const img = el as HTMLImageElement
              return img.complete && img.naturalWidth > 0
            })
            .catch(() => false),
        {
          message:
            'The artwork <img> is on the page but the image never decoded (naturalWidth 0) — ' +
            'a broken-image icon. Storage is unreachable, or the signed URL was rejected/expired.',
          timeout: 30_000,
        },
      )
      .toBe(true)

    // ── 4. Softer corroboration ──────────────────────────────────────────
    // Soft so that ONE run reports everything that is wrong, rather than
    // stopping at the first problem and hiding the rest.

    // Real per-recipient data came back, not just the company header.
    await expect
      .soft(
        page.getByText(EXPECT_CONTACT).first(),
        `The recipient name "${EXPECT_CONTACT}" is missing. The RPC answered but the version ` +
          `payload looks wrong — check public_get_customer_proof's shape.`,
      )
      .toBeVisible()

    // Every artwork image that rendered, not just the first.
    const brokenImages = await page.locator(ARTWORK).evaluateAll((els) =>
      els
        .map((el) => el as HTMLImageElement)
        .filter((img) => img.complete && img.naturalWidth === 0)
        .map((img) => img.src.split('?')[0]),
    )
    expect
      .soft(brokenImages, `Some artwork images finished loading but decoded to nothing.`)
      .toEqual([])

    // The anon-key check. Also catches a dropped EXECUTE grant or an edge
    // function returning 500.
    expect
      .soft(
        supabaseFailures,
        'Requests to Supabase failed while rendering. A 401 here is very likely a rotated or ' +
          'stale VITE_SUPABASE_ANON_KEY baked into the Netlify build — the failure mode no HTTP ' +
          'monitor can see, because Netlify still serves 200.',
      )
      .toEqual([])

    expect
      .soft(pageErrors, 'The page threw uncaught errors while rendering.')
      .toEqual([])
  })
})
