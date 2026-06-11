import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
import SetNewPasswordPage from './pages/SetNewPasswordPage'
import { useQuoteShortcut } from './lib/useQuoteShortcut'
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
import CustomerDetailPage from './pages/CustomerDetailPage'
import QuotePage from './pages/QuotePage'
import AdminLayout from './pages/admin/AdminLayout'
import AdminUsersPage from './pages/admin/AdminUsersPage'
import AdminPricingPage from './pages/admin/AdminPricingPage'
import AdminMaterialsPage from './pages/admin/AdminMaterialsPage'
import AdminMaterialEditor from './pages/admin/AdminMaterialEditor'
import AdminAddOnEditor from './pages/admin/AdminAddOnEditor'
import AdminActivityPage from './pages/admin/AdminActivityPage'
import AdminSettingsPage from './pages/admin/AdminSettingsPage'
import AdminTemplatesPage from './pages/admin/AdminTemplatesPage'
import AdminSiteCopyPage from './pages/admin/AdminSiteCopyPage'
import AdminAiDraftsPage from './pages/admin/AdminAiDraftsPage'
import AdminCreateMaterialPage from './pages/admin/AdminCreateMaterialPage'
import AdminCoreColoursPage from './pages/admin/AdminCoreColoursPage'
import AdminNeedsAttentionPage from './pages/admin/AdminNeedsAttentionPage'
import AdminLeadTimesPage from './pages/admin/AdminLeadTimesPage'
import AdminCardWeightsPage from './pages/admin/AdminCardWeightsPage'
import DesignDemo from './design/_demo'

// Inner shell so the Cmd-K / Ctrl-K shortcut can mount inside the
// router. Lives here rather than directly in App so the hook has
// access to a Router context if it ever needs to navigate
// programmatically; today it just window.opens a new tab.
function AppShell() {
  useQuoteShortcut()
  const { recovery } = useAuth()
  // A password-recovery link signs the user in, so without this they would land
  // on the dashboard and never be prompted. Take over the whole app until they
  // set a new password (or acknowledge an expired link).
  if (recovery !== 'none') return <SetNewPasswordPage />
  return (
    <Routes>
      {/* Public */}
      <Route path="/p/:id" element={<CustomerProofPage />} />
      <Route path="/login" element={<LoginPage />} />

      {/* Reskin design-system demo (PR 2). Public so reviewers can
          hit it without auth; the route name is deliberately
          underscore-prefixed so it can't collide with a real
          customer or admin URL. Will move under /admin or be
          deleted once the reskin lands on main. */}
      <Route path="/__design" element={<DesignDemo />} />

      {/* Authenticated */}
      <Route path="/" element={<RequireAuth><DashboardPage /></RequireAuth>} />
      <Route path="/quote" element={<RequireAuth><QuotePage /></RequireAuth>} />
      <Route path="/proofs/new" element={<RequireAuth><NewProofPage /></RequireAuth>} />
      <Route path="/proofs/:id" element={<RequireAuth><ProofDetailPage /></RequireAuth>} />
      <Route path="/proofs/:id/versions/new" element={<RequireAuth><NewVersionPage /></RequireAuth>} />
      <Route path="/proofs/:id/versions/:versionId/edit" element={<RequireAuth><EditVersionPage /></RequireAuth>} />
      {/* Legacy redirect: Customers moved into the Admin shell as a
          tab. Bookmarks and old in-flight links land here and bounce
          to the new home. The destination is itself RequireAdmin-
          gated via the /admin parent route, so non-admins still get
          the usual / redirect — the extra hop is invisible. */}
      <Route path="/customers" element={<Navigate to="/admin/customers" replace />} />

      {/* Admin area — all paths under /admin go through the admin shell */}
      <Route path="/admin" element={<RequireAdmin><AdminLayout /></RequireAdmin>}>
        <Route index element={<Navigate to="users" replace />} />
        <Route path="users" element={<AdminUsersPage />} />
        <Route path="customers" element={<CustomersPage />} />
        <Route path="customers/:companyId" element={<CustomerDetailPage />} />
        <Route path="materials" element={<AdminMaterialsPage />} />
        <Route path="pricing" element={<AdminPricingPage />} />
        <Route path="lead-times" element={<AdminLeadTimesPage />} />
        <Route path="card-weights" element={<AdminCardWeightsPage />} />
        <Route path="materials/new" element={<AdminCreateMaterialPage />} />
        <Route path="pricing/materials/:code" element={<AdminMaterialEditor />} />
        <Route path="pricing/add-ons/:code" element={<AdminAddOnEditor />} />
        <Route path="core-colours" element={<AdminCoreColoursPage />} />
        <Route path="needs-attention" element={<AdminNeedsAttentionPage />} />
        <Route path="activity" element={<AdminActivityPage />} />
        <Route path="templates" element={<AdminTemplatesPage />} />
        <Route path="site-copy" element={<AdminSiteCopyPage />} />
        <Route path="ai-drafts" element={<AdminAiDraftsPage />} />
        <Route path="settings" element={<AdminSettingsPage />} />
      </Route>
    </Routes>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppShell />
      </BrowserRouter>
    </AuthProvider>
  )
}
