// Verification playground: renders real designer/admin pages against the
// fixture supabase client (see vite.verify.config.ts aliases). Run with
//   pnpm vite --config vite.verify.config.ts
// and open /verify-harness/index.html.
//
// Defaults to the OrdersPage. Pass ?path=/admin/... to mount the admin
// shell instead (real AdminLayout + the consolidated tab pages, incl.
// /admin/shipping) — used to visually verify the grouped admin nav; data
// comes back empty from the fixture client, which is fine for layout checks.
// Pass ?path=/dashboard for the dashboard, wrapped in the real
// TeamChatProvider so the right rail's docked-chat layout can be checked
// (set localStorage 'pv:chat-placement' to 'docked' first).
// Pass ?path=/flagged for the Flagged board (watch_items / watch_updates
// fixtures in mock-supabase) — used to verify the card layout at mobile
// widths (the page uniquely carries both a search field and a header CTA).
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import OrdersPage from '../src/pages/OrdersPage'
import OrderReviewPage from '../src/pages/OrderReviewPage'
import DashboardPage from '../src/pages/DashboardPage'
import FlaggedPage from '../src/pages/FlaggedPage'
import FeedbackPage from '../src/pages/FeedbackPage'
import { TeamChatProvider } from '../src/lib/teamChatStore'
import DesignerSearch from '../src/components/DesignerSearch'
import AdminLayout from '../src/pages/admin/AdminLayout'
import AdminHomePage from '../src/pages/admin/AdminHomePage'
import AdminCatalogueDataPage from '../src/pages/admin/AdminCatalogueDataPage'
import AdminContentPage from '../src/pages/admin/AdminContentPage'
import AdminNeedsAttentionPage from '../src/pages/admin/AdminNeedsAttentionPage'
import AdminShippingPage from '../src/pages/admin/AdminShippingPage'
import AdminSettingsPage from '../src/pages/admin/AdminSettingsPage'
import { SpreadQuoteResults } from '../src/components/quote/SpreadQuoteResults'
import '../src/index.css'

// ?path=/quote-spread mounts the Quote compiler's spread-quote results card
// on its own, inside the same lg:grid-cols-[1fr_22rem] shell QuotePage uses,
// so the 22rem results column's real width is reproduced. The card needs no
// Supabase data — every input is a prop — so this is a pure layout rig.
function QuoteSpreadRig() {
  const tiers = [100, 250, 500, 1000, 2000, 5000, 10000].map((quantity) => ({
    variantId: 'v1',
    quantity,
    totalPrice: 139 + quantity * 0.38,
  }))
  // 137 isn't a tier — exercises the "Not priced" row and its
  // inline swap buttons alongside the personalisation subline.
  return (
    <div className="min-h-screen bg-canvas">
      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
          <div />
          <div className="space-y-6">
            <SpreadQuoteResults
              quantities={[100, 137, 250, 10000]}
              onChangeQuantities={() => {}}
              variantTiers={tiers}
              finishSurchargesByQty={null}
              currency="GBP"
              materialDisplayName="Full Colour Plastic"
              variantDisplayName="420 micron"
              finishOption={null}
              splitNameSurcharge={0}
              names={1}
              perExtraNameSurcharge={null}
              personalisationAt={(qty) => Math.max(50, qty * 0.2)}
              personalisationActive
              personalisationBreakevenQty={250}
              customFlags={{ nfc: false }}
              discountPercent={0}
              includeLeadTime={false}
              onIncludeLeadTimeChange={() => {}}
              leadTimeState={null}
              loading={false}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function Elsewhere() {
  return <div style={{ padding: 40 }} data-nav-target>navigated away</div>
}

function Stub() {
  return <div style={{ padding: 40 }} data-nav-target>stub admin page</div>
}

const requestedPath = new URLSearchParams(window.location.search).get('path')

// ?path=/palette mounts the ⌘K designer command palette on its own, open, so
// its layout and the fixture-backed proof search can be checked headlessly.
const tree = requestedPath === '/quote-spread' ? (
  <QuoteSpreadRig />
) : requestedPath === '/palette' ? (
  <MemoryRouter initialEntries={['/']}>
    <Routes>
      <Route path="/" element={<DesignerSearch open onClose={() => {}} />} />
    </Routes>
  </MemoryRouter>
) : requestedPath === '/flagged' ? (
  <MemoryRouter initialEntries={['/']}>
    <Routes>
      <Route path="/" element={<FlaggedPage />} />
      <Route path="*" element={<Elsewhere />} />
    </Routes>
  </MemoryRouter>
) : requestedPath === '/feedback' ? (
  <MemoryRouter initialEntries={['/']}>
    <Routes>
      <Route path="/" element={<FeedbackPage />} />
      <Route path="*" element={<Elsewhere />} />
    </Routes>
  </MemoryRouter>
) : requestedPath === '/dashboard' ? (
  <TeamChatProvider>
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="*" element={<Elsewhere />} />
      </Routes>
    </MemoryRouter>
  </TeamChatProvider>
) : requestedPath?.startsWith('/admin') ? (
  <MemoryRouter initialEntries={[requestedPath]}>
    <Routes>
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<AdminHomePage />} />
        <Route path="catalogue/:tab" element={<AdminCatalogueDataPage />} />
        <Route path="content/:tab" element={<AdminContentPage />} />
        <Route path="needs-attention" element={<AdminNeedsAttentionPage />} />
        <Route path="shipping" element={<AdminShippingPage />} />
        <Route path="settings" element={<AdminSettingsPage />} />
        <Route path="*" element={<Stub />} />
      </Route>
      <Route path="*" element={<Elsewhere />} />
    </Routes>
  </MemoryRouter>
) : requestedPath?.startsWith('/orders/') ? (
  // ?path=/orders/o1/place — the place-order review screen against the
  // fixture place-order preview (incl. the Stock Control hand-off checks).
  <MemoryRouter initialEntries={[requestedPath]}>
    <Routes>
      <Route path="/orders/:id/place" element={<OrderReviewPage />} />
      <Route path="*" element={<Elsewhere />} />
    </Routes>
  </MemoryRouter>
) : (
  <MemoryRouter initialEntries={['/orders']}>
    <Routes>
      <Route path="/orders" element={<OrdersPage />} />
      <Route path="*" element={<Elsewhere />} />
    </Routes>
  </MemoryRouter>
)

createRoot(document.getElementById('root')!).render(<StrictMode>{tree}</StrictMode>)
