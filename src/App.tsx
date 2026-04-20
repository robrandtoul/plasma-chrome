import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './lib/auth'
import RequireAuth from './components/RequireAuth'
import RequireAdmin from './components/RequireAdmin'
import CustomerProofPage from './pages/CustomerProofPage'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import NewProofPage from './pages/NewProofPage'
import ProofDetailPage from './pages/ProofDetailPage'
import NewVersionPage from './pages/NewVersionPage'
import EditVersionPage from './pages/EditVersionPage'
import CustomersPage from './pages/CustomersPage'
import AdminLayout from './pages/admin/AdminLayout'
import AdminUsersPage from './pages/admin/AdminUsersPage'
import AdminPricingPage from './pages/admin/AdminPricingPage'

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          {/* Public */}
          <Route path="/p/:id" element={<CustomerProofPage />} />
          <Route path="/login" element={<LoginPage />} />

          {/* Authenticated */}
          <Route path="/" element={<RequireAuth><DashboardPage /></RequireAuth>} />
          <Route path="/proofs/new" element={<RequireAuth><NewProofPage /></RequireAuth>} />
          <Route path="/proofs/:id" element={<RequireAuth><ProofDetailPage /></RequireAuth>} />
          <Route path="/proofs/:id/versions/new" element={<RequireAuth><NewVersionPage /></RequireAuth>} />
          <Route path="/proofs/:id/versions/:versionId/edit" element={<RequireAuth><EditVersionPage /></RequireAuth>} />
          <Route path="/customers" element={<RequireAuth><CustomersPage /></RequireAuth>} />

          {/* Admin area — all paths under /admin go through the admin shell */}
          <Route path="/admin" element={<RequireAdmin><AdminLayout /></RequireAdmin>}>
            <Route index element={<Navigate to="users" replace />} />
            <Route path="users" element={<AdminUsersPage />} />
            <Route path="pricing" element={<AdminPricingPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
