// Verification playground: renders real designer/admin pages against the
// fixture supabase client (see vite.verify.config.ts aliases). Run with
//   pnpm vite --config vite.verify.config.ts
// and open /verify-harness/index.html.
//
// Defaults to the OrdersPage. Pass ?path=/admin/... to mount the admin
// shell instead (real AdminLayout + the consolidated tab pages, incl.
// /admin/shipping) — used to visually verify the grouped admin nav; data
// comes back empty from the fixture client, which is fine for layout checks.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import OrdersPage from '../src/pages/OrdersPage'
import DesignerSearch from '../src/components/DesignerSearch'
import AdminLayout from '../src/pages/admin/AdminLayout'
import AdminHomePage from '../src/pages/admin/AdminHomePage'
import AdminCatalogueDataPage from '../src/pages/admin/AdminCatalogueDataPage'
import AdminContentPage from '../src/pages/admin/AdminContentPage'
import AdminNeedsAttentionPage from '../src/pages/admin/AdminNeedsAttentionPage'
import AdminShippingPage from '../src/pages/admin/AdminShippingPage'
import AdminSettingsPage from '../src/pages/admin/AdminSettingsPage'
import '../src/index.css'

function Elsewhere() {
  return <div style={{ padding: 40 }} data-nav-target>navigated away</div>
}

function Stub() {
  return <div style={{ padding: 40 }} data-nav-target>stub admin page</div>
}

const requestedPath = new URLSearchParams(window.location.search).get('path')

// ?path=/palette mounts the ⌘K designer command palette on its own, open, so
// its layout and the fixture-backed proof search can be checked headlessly.
const tree = requestedPath === '/palette' ? (
  <MemoryRouter initialEntries={['/']}>
    <Routes>
      <Route path="/" element={<DesignerSearch open onClose={() => {}} />} />
    </Routes>
  </MemoryRouter>
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
) : (
  <MemoryRouter initialEntries={['/orders']}>
    <Routes>
      <Route path="/orders" element={<OrdersPage />} />
      <Route path="*" element={<Elsewhere />} />
    </Routes>
  </MemoryRouter>
)

createRoot(document.getElementById('root')!).render(<StrictMode>{tree}</StrictMode>)
