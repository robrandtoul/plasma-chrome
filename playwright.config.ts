import { defineConfig, devices } from '@playwright/test'

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
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${CUSTOMER_PORT}` },
    },
    {
      // 57% of change requests are submitted from a phone, so the customer
      // surfaces get a phone run too rather than desktop-only.
      name: 'customer-mobile',
      testMatch: /customer\/.*\.spec\.ts/,
      use: { ...devices['iPhone 14'], baseURL: `http://localhost:${CUSTOMER_PORT}` },
    },
    {
      name: 'designer',
      testMatch: /designer\/.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${HARNESS_PORT}` },
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
