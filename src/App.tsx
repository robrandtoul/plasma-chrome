import { Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
import { lazyWithRetry } from './lib/lazyWithRetry'
import { useQuoteShortcut } from './lib/useQuoteShortcut'
import RequireAuth from './components/RequireAuth'
import RequireAdmin from './components/RequireAdmin'

// Eager imports — the auth-critical path. LoginPage and SetNewPasswordPage
// stay in the entry chunk so the sign-in / password-recovery flow renders
// without a lazy-chunk flash (SetNewPasswordPage is rendered directly below,
// outside <Routes>, so it can't sit behind the route-level <Suspense>).
import LoginPage from './pages/LoginPage'
import SetNewPasswordPage from './pages/SetNewPasswordPage'

// Everything else is lazy-loaded so each page ships as its own chunk. A
// customer hitting /p/:id no longer downloads the entire designer + admin app,
// and a deploy that only touches one page re-downloads only that page's chunk
// (the shared react/router/supabase vendor chunks stay cached — see
// vite.config.ts manualChunks).
const CustomerProofPage = lazyWithRetry(() => import('./pages/CustomerProofPage'), 'CustomerProofPage')
const OrderPayPage = lazyWithRetry(() => import('./pages/OrderPayPage'), 'OrderPayPage')
const DashboardPage = lazyWithRetry(() => import('./pages/DashboardPage'), 'DashboardPage')
const NewProofPage = lazyWithRetry(() => import('./pages/NewProofPage'), 'NewProofPage')
const ProofDetailPage = lazyWithRetry(() => import('./pages/ProofDetailPage'), 'ProofDetailPage')
const NewVersionPage = lazyWithRetry(() => import('./pages/NewVersionPage'), 'NewVersionPage')
const EditVersionPage = lazyWithRetry(() => import('./pages/EditVersionPage'), 'EditVersionPage')
const CustomersPage = lazyWithRetry(() => import('./pages/CustomersPage'), 'CustomersPage')
const CustomerDetailPage = lazyWithRetry(() => import('./pages/CustomerDetailPage'), 'CustomerDetailPage')
const QuotePage = lazyWithRetry(() => import('./pages/QuotePage'), 'QuotePage')
const OrdersPage = lazyWithRetry(() => import('./pages/OrdersPage'), 'OrdersPage')
const OrderReviewPage = lazyWithRetry(() => import('./pages/OrderReviewPage'), 'OrderReviewPage')
const FeedbackPage = lazyWithRetry(() => import('./pages/FeedbackPage'), 'FeedbackPage')
const NotificationSettingsPage = lazyWithRetry(() => import('./pages/NotificationSettingsPage'), 'NotificationSettingsPage')
const AdminLayout = lazyWithRetry(() => import('./pages/admin/AdminLayout'), 'AdminLayout')
const AdminUsersPage = lazyWithRetry(() => import('./pages/admin/AdminUsersPage'), 'AdminUsersPage')
const AdminPricingPage = lazyWithRetry(() => import('./pages/admin/AdminPricingPage'), 'AdminPricingPage')
const AdminMaterialsPage = lazyWithRetry(() => import('./pages/admin/AdminMaterialsPage'), 'AdminMaterialsPage')
const AdminMaterialEditor = lazyWithRetry(() => import('./pages/admin/AdminMaterialEditor'), 'AdminMaterialEditor')
const AdminAddOnEditor = lazyWithRetry(() => import('./pages/admin/AdminAddOnEditor'), 'AdminAddOnEditor')
const AdminActivityPage = lazyWithRetry(() => import('./pages/admin/AdminActivityPage'), 'AdminActivityPage')
const AdminOrderLogPage = lazyWithRetry(() => import('./pages/admin/AdminOrderLogPage'), 'AdminOrderLogPage')
const AdminSettingsPage = lazyWithRetry(() => import('./pages/admin/AdminSettingsPage'), 'AdminSettingsPage')
const AdminTemplatesPage = lazyWithRetry(() => import('./pages/admin/AdminTemplatesPage'), 'AdminTemplatesPage')
const AdminOutsourcingPage = lazyWithRetry(() => import('./pages/admin/AdminOutsourcingPage'), 'AdminOutsourcingPage')
const AdminSiteCopyPage = lazyWithRetry(() => import('./pages/admin/AdminSiteCopyPage'), 'AdminSiteCopyPage')
const AdminAiDraftsPage = lazyWithRetry(() => import('./pages/admin/AdminAiDraftsPage'), 'AdminAiDraftsPage')
const AdminCreateMaterialPage = lazyWithRetry(() => import('./pages/admin/AdminCreateMaterialPage'), 'AdminCreateMaterialPage')
const AdminCoreColoursPage = lazyWithRetry(() => import('./pages/admin/AdminCoreColoursPage'), 'AdminCoreColoursPage')
const AdminNeedsAttentionPage = lazyWithRetry(() => import('./pages/admin/AdminNeedsAttentionPage'), 'AdminNeedsAttentionPage')
const AdminLeadTimesPage = lazyWithRetry(() => import('./pages/admin/AdminLeadTimesPage'), 'AdminLeadTimesPage')
const AdminCardWeightsPage = lazyWithRetry(() => import('./pages/admin/AdminCardWeightsPage'), 'AdminCardWeightsPage')
const AdminPrototypePricesPage = lazyWithRetry(() => import('./pages/admin/AdminPrototypePricesPage'), 'AdminPrototypePricesPage')
const AdminXeroItemCodesPage = lazyWithRetry(() => import('./pages/admin/AdminXeroItemCodesPage'), 'AdminXeroItemCodesPage')
const AdminMaterialOptionsPage = lazyWithRetry(() => import('./pages/admin/AdminMaterialOptionsPage'), 'AdminMaterialOptionsPage')
const AdminXeroSelfTestPage = lazyWithRetry(() => import('./pages/admin/AdminXeroSelfTestPage'), 'AdminXeroSelfTestPage')
const AdminAnalyticsPage = lazyWithRetry(() => import('./pages/admin/AdminAnalyticsPage'), 'AdminAnalyticsPage')
const DesignDemo = lazyWithRetry(() => import('./design/_demo'), 'DesignDemo')

// Shown while a lazy route chunk is in flight. Mirrors the centred spinner
// RequireAuth uses during its auth check, so a cold navigation that hits both
// (auth check, then chunk fetch) looks like one continuous loading state.
function RouteFallback() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-gray-900" />
    </div>
  )
}

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
  // SetNewPasswordPage is an eager import, so this never suspends today; the
  // Suspense boundary is belt-and-braces so the recovery path stays safe even
  // if that page (or something it imports) later becomes lazy.
  if (recovery !== 'none') {
    return (
      <Suspense fallback={<RouteFallback />}>
        <SetNewPasswordPage />
      </Suspense>
    )
  }
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        {/* Public */}
        <Route path="/p/:id" element={<CustomerProofPage />} />
        <Route path="/order/:id" element={<OrderPayPage />} />
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
        <Route path="/orders" element={<RequireAuth><OrdersPage /></RequireAuth>} />
        <Route path="/orders/:id/place" element={<RequireAuth><OrderReviewPage /></RequireAuth>} />
        <Route path="/feedback" element={<RequireAuth><FeedbackPage /></RequireAuth>} />
        <Route path="/settings/notifications" element={<RequireAuth><NotificationSettingsPage /></RequireAuth>} />
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
          <Route path="analytics" element={<AdminAnalyticsPage />} />
          <Route path="users" element={<AdminUsersPage />} />
          <Route path="customers" element={<CustomersPage />} />
          <Route path="customers/:companyId" element={<CustomerDetailPage />} />
          <Route path="orders" element={<AdminOrderLogPage />} />
          <Route path="materials" element={<AdminMaterialsPage />} />
          <Route path="material-options" element={<AdminMaterialOptionsPage />} />
          <Route path="pricing" element={<AdminPricingPage />} />
          <Route path="lead-times" element={<AdminLeadTimesPage />} />
          <Route path="card-weights" element={<AdminCardWeightsPage />} />
          <Route path="prototype-prices" element={<AdminPrototypePricesPage />} />
          <Route path="outsourcing" element={<AdminOutsourcingPage />} />
          <Route path="xero-item-codes" element={<AdminXeroItemCodesPage />} />
          <Route path="xero-self-test" element={<AdminXeroSelfTestPage />} />
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
    </Suspense>
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
