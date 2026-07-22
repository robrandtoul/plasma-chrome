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
import AdminArtworkCheckPage from '../src/pages/admin/AdminArtworkCheckPage'
import { SpreadQuoteResults } from '../src/components/quote/SpreadQuoteResults'
import { RecapArtwork, buildRecapTiles } from '../src/components/ArtworkFade'
import type { GridImage } from '../src/components/ImageGrid'
import { useEffect } from 'react'
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

// ?path=/recap-zoom mounts the pay-page approved-artwork recap on its own,
// inside the order-summary panel, so the click-to-expand affordance and the
// ProofDetailView zoom viewer it opens can be checked headlessly (the real
// pay page needs a live order + Stripe, so it can't run in the harness).
// Self-contained SVG data-URI "artwork" so no network is needed.
function cardSvg(bg: string, fg: string, title: string, sub: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="384" viewBox="0 0 640 384">` +
    `<rect width="640" height="384" fill="${bg}"/>` +
    `<rect x="24" y="24" width="592" height="336" rx="14" fill="none" stroke="${fg}" stroke-opacity="0.25"/>` +
    `<text x="56" y="176" font-family="Georgia, serif" font-size="44" fill="${fg}">${title}</text>` +
    `<text x="56" y="228" font-family="Arial, sans-serif" font-size="22" fill="${fg}" fill-opacity="0.7">${sub}</text>` +
    `</svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}
function RecapZoomRig() {
  useEffect(() => {
    document.documentElement.classList.add('customer-accent')
    return () => document.documentElement.classList.remove('customer-accent')
  }, [])
  const images: GridImage[] = [
    { id: 'front', signed_url: cardSvg('#1f2733', '#f4efe7', 'Ada Lovelace', 'Head of Engineering'), side: 'front', material_option: null },
    { id: 'back', signed_url: cardSvg('#f4efe7', '#1f2733', 'PLASMA', 'plasmadesign.co.uk'), side: 'back', material_option: null },
  ]
  const tiles = buildRecapTiles(images, null, [], false)
  return (
    <div className="min-h-screen bg-canvas">
      <div className="mx-auto max-w-md px-4 py-10">
        <div className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-ink-mute">Order summary</p>
            <p className="text-[12px] text-ink-mute">Approved 22 Jul 2026</p>
          </div>
          <RecapArtwork tiles={tiles} label="Stainless Steel" className="mt-3" />
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-ink-mute">Material</dt>
            <dd className="text-ink">Stainless Steel</dd>
          </dl>
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
) : requestedPath === '/recap-zoom' ? (
  <RecapZoomRig />
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
        <Route path="artwork-check" element={<AdminArtworkCheckPage />} />
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
