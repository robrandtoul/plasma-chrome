import { defineConfig, devices } from '@playwright/test'
import fs from 'node:fs'

// Managed cloud sandboxes pre-install a Chromium at a fixed path and block
// `playwright install`, so when the pinned @playwright/test wants a browser
// revision that isn't there, fall back to the sandbox binary. Absent on real
// dev machines and in CI (both install matching browsers), so this is a no-op
// everywhere else.
const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium'
const sandboxLaunch = fs.existsSync(SANDBOX_CHROMIUM)
  ? { launchOptions: { executablePath: SANDBOX_CHROMIUM } }
  : {}

// The harness projects are offline by design — a fixture supabase client and
// no auth — so external requests (the Google Fonts @import in index.css,
// Stripe's js) must FAIL FAST rather than load or hang: pointing the browser
// at a dead proxy makes every non-localhost request refuse instantly. Without
// this, a sandboxed or slow network turns every page load into a ~25s stall
// waiting on fonts, and a harness test silently grows a real-internet
// dependency. The customer projects talk to the real Supabase project, so
// they deliberately don't get this.
const offline = { proxy: { server: 'http://127.0.0.1:9', bypass: 'localhost,127.0.0.1' } }

// End-to-end tests, added after three bugs shipped that no existing test could
// have caught (a control in the wrong place, a schema/UI contradiction, and a
// marker rendering off from where it was clicked). Every other test in this repo
// asserts pure functions; nothing rendered a component, so nothing could catch
// "the pin is not under my cursor".
//
// Two targets, because they verify different things:
//
//   • CUSTOMER pages run against `pnpm dev` and the REAL Supabase project over
//     the anon path — the same RPCs and edge functions production uses. Needs a
//     .env with VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY (both public; the
//     anon key ships in the frontend bundle). Scoped to the Atari Corp fixture
//     projects, which are not real customers — never point these at a live
//     customer proof, since loading one records a view against it.
//
//   • DESIGNER pages run against the verify harness, which mocks auth and the
//     Supabase client. That is the only way to reach signed-in surfaces here: an
//     agent cannot type a password, and mustn't.
//
// Both servers are started by Playwright and reused if already running.

const CUSTOMER_PORT = 5173
const HARNESS_PORT = 5199

export default defineConfig({
  testDir: './e2e',
  // Serial by default: both projects share one live database, and a test that
  // writes fixture data must not race another reading it.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],
  timeout: 30_000,
  expect: { timeout: 7_000 },

  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'customer',
      testMatch: /customer\/.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], ...sandboxLaunch, baseURL: `http://localhost:${CUSTOMER_PORT}` },
    },
    {
      // 57% of change requests are submitted from a phone, so the customer
      // surfaces get a phone run too rather than desktop-only.
      name: 'customer-mobile',
      testMatch: /customer\/.*\.spec\.ts/,
      use: { ...devices['iPhone 14'], ...sandboxLaunch, baseURL: `http://localhost:${CUSTOMER_PORT}` },
    },
    {
      name: 'designer',
      testMatch: /designer\/.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], ...sandboxLaunch, ...offline, baseURL: `http://localhost:${HARNESS_PORT}` },
    },
    {
      // The regression suite proper (August 2026): every spec under
      // e2e/harness/ runs fully offline against the verify harness — no
      // Supabase project, no auth, no network — so this project is the one CI
      // runs on every pull request. Customer-page and pay-page specs live
      // here too (not under customer/), precisely because they must not need
      // the real backend.
      name: 'harness',
      testMatch: /harness\/.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], ...sandboxLaunch, ...offline, baseURL: `http://localhost:${HARNESS_PORT}` },
    },
  ],

  webServer: [
    {
      command: 'pnpm dev',
      port: CUSTOMER_PORT,
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'pnpm vite --config vite.verify.config.ts',
      port: HARNESS_PORT,
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
})
