import { defineConfig, devices } from '@playwright/test'

// Tier 3 synthetic check — a REAL browser against PRODUCTION.
//
// Deliberately a second config rather than a project inside playwright.config.ts.
// That file starts `pnpm dev` and the verify harness and points at localhost;
// this one starts nothing and points at the live site. Mixing them would mean
// `pnpm test:e2e` silently began hitting production, which is exactly the kind
// of surprise that gets monitoring switched off. The specs also live in their
// own directory (e2e-prod/, not e2e/) so the default run cannot pick them up
// even by accident.
//
// WHAT THIS COVERS THAT THE HTTP MONITORS CANNOT
// ----------------------------------------------
// public/_redirects ends with `/*  /index.html  200`, so a broken React
// bundle, a dead customer-proof-images function, a changed RPC shape, or a
// Netlify build carrying a stale VITE_SUPABASE_ANON_KEY all still answer 200
// with the shell. Every existing Better Stack monitor stays green through all
// four. Only rendering a real proof in a real browser catches them.
//
// This is the BACKSTOP, not the fast alarm — the nine HTTP monitors already
// catch quick failures within ~3 minutes. This runs on deploy and every 2h.

const BASE_URL = process.env.PROOF_VIEW_BASE_URL ?? 'https://proofs.plasmadesign.co.uk'

export default defineConfig({
  testDir: './e2e-prod',
  // One spec, one worker: this is a monitor, not a test suite. Nothing here
  // writes, so parallelism would buy nothing and only add load to production.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,

  // Retries are about the PUBLIC INTERNET, not about the assertions. A single
  // TCP reset or DNS blip between GitHub's runner and Netlify must not page
  // anyone at 3am; a genuine breakage fails all three attempts identically.
  // No assertion is relaxed to earn this — see the spec, which asserts the
  // same things on every attempt.
  retries: 2,

  // Generous: a cold Netlify edge, a cold Supabase isolate signing storage
  // URLs, and the page's own 2.5s settle all land inside one run.
  timeout: 90_000,
  expect: { timeout: 20_000 },

  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: BASE_URL,
    // The whole point of running this in Actions rather than as a hosted
    // browser monitor: a failure leaves a trace and a screenshot you can
    // actually open, instead of a red dot.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'proof-view',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
