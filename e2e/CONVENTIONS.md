# E2E conventions (read before writing a spec)

How the end-to-end suite works in this repo, and the rules that keep parallel
spec-writing safe. The existing specs in `e2e/designer/` are the style
reference — read `customer-pins.spec.ts` before writing anything.

## Architecture

Three Playwright projects (`playwright.config.ts`):

- **`harness`** (`e2e/harness/*.spec.ts`) — the regression suite. Runs fully
  offline against the verify harness on port **5199**: real pages, fixture
  supabase client, mocked auth. This is what CI runs. New specs go here.
- **`designer`** (`e2e/designer/*.spec.ts`) — the pre-existing harness specs.
  Same server; don't add to it, and don't duplicate what it already covers
  (customer pins, preview gate).
- **`customer` / `customer-mobile`** (`e2e/customer/*.spec.ts`) — run against
  `pnpm dev` + the REAL Supabase project and the live Atari Corp fixtures.
  Never add to these without explicit instruction: they touch live data.

## Reaching a page

```ts
await page.goto('/verify-harness/index.html?path=/orders')
```

⚠ The harness lives at `/verify-harness/index.html` — `/` on this port serves
the real app against a dead backend. This trap has cost time before.

`?path=` values are dispatched in `verify-harness/entry.tsx` (read its chain
before assuming a route exists). Extra query params are passed through to the
page's router, so `?path=/order/pay-1&token=tok` reaches the pay page as
`/order/pay-1?token=tok`. Some rigs read `&state=…` themselves
(`/abandon-dialog`, `/order-builder`).

## Fixture data

`verify-harness/mock-supabase.ts` fakes the supabase client: a thenable query
builder resolving fixtures keyed on (schema, table, select string, filters),
plus `rpc(name, args)`, `functions.invoke(name, body)`, storage and realtime
stubs. Unknown tables/RPCs resolve empty so unrelated chrome never breaks a
page. Limitations worth knowing:

- Only `eq` / `in` / `neq` / `gte` filters are recorded; `order`, `limit`,
  `ilike`, `or` etc. chain as no-ops.
- The mock is **stateless**: writes are accepted and dropped, so a UI flow can
  be asserted up to and including its optimistic/confirmation state, but not a
  post-refetch state change. Don't fight this — assert what the page shows.
- Storage writes are no-ops that succeed.

**Adding fixtures:** new-page fixtures live in per-area modules under
`verify-harness/fixtures/` (`customer-proof.ts`, `pay-pages.ts`,
`version-form.ts`). `mock-supabase.ts` tries these hooks first and falls
through to its own data when they return `null`. A hook must claim ONLY
requests carrying its own fixture-id prefix (`cp-` / `pay-` / `grp-` / `vf-`)
and return `null` for everything else. Derive payload shapes from the real
page's data code, not from guesswork.

## Shared files — do not edit

Unless a file is explicitly yours, treat these as read-only:
`verify-harness/entry.tsx`, `verify-harness/mock-supabase.ts`,
`verify-harness/mock-auth.tsx`, `playwright.config.ts`, `package.json`,
`e2e/CONVENTIONS.md`, anything under `e2e/` you didn't create. If a test needs
a capability that's missing (a route, a fixture state, a rig), don't bodge it
— leave the test unwritten and report the gap.

## Writing specs

- **Assert structure, never wording.** Copy changes constantly; roles, counts,
  order, state and geometry don't. `getByRole` first, test-ids never (there
  are none), CSS selectors only when a role genuinely doesn't exist.
- Prefer before/after comparisons over pinned values (colours especially).
- No `waitForTimeout` — Playwright's auto-waiting expects are enough; the
  harness has no network latency.
- Each test must pass alone and in any order; no state leaks between tests
  (the mock resets on every page load anyway).
- Comment the WHY, in full sentences, matching the house style — a spec's
  header explains what real failure it exists to catch.
- A page that renders an uncaught React error logs
  `[harness] uncaught render error` to the console — smoke tests should fail
  on any console error containing that marker.

## Running what you wrote

```sh
pnpm exec playwright test e2e/harness/<your-file>.spec.ts 2>&1 | tail -25
```

Both dev servers are long-running and reused (`reuseExistingServer`) — do not
kill or restart them. A spec is not done until it has run green; a spec that
has never failed in front of you is also suspect — sanity-check that its
assertions can fail (e.g. run once against a deliberately wrong expectation if
in doubt). Never commit `test-results/` or `playwright-report/`.
