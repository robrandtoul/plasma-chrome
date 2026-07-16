// Verification playground: renders real designer/admin pages against the
// fixture supabase client (see vite.verify.config.ts aliases). Run with
//   pnpm vite --config vite.verify.config.ts
// and open /verify-harness/index.html. Use the top nav to switch pages.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom'
import OrdersPage from '../src/pages/OrdersPage'
import AdminShippingPage from '../src/pages/admin/AdminShippingPage'
import '../src/index.css'

function Elsewhere() {
  return <div style={{ padding: 40 }} data-nav-target>navigated away</div>
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MemoryRouter initialEntries={['/orders']}>
      <nav style={{ display: 'flex', gap: 16, padding: '8px 16px', borderBottom: '1px solid #e5e7eb' }}>
        <Link to="/orders">Orders</Link>
        <Link to="/admin/shipping">Shipping</Link>
      </nav>
      <Routes>
        <Route path="/orders" element={<OrdersPage />} />
        <Route path="/admin/shipping" element={<AdminShippingPage />} />
        <Route path="*" element={<Elsewhere />} />
      </Routes>
    </MemoryRouter>
  </StrictMode>,
)
