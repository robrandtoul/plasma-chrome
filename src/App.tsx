import { Suspense, useCallback, useLayoutEffect, useState } from 'react'
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
  useNavigationType,
} from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
import { TeamChatProvider } from './lib/teamChatStore'
import { lazyWithRetry } from './lib/lazyWithRetry'
import { useDesignerShortcuts } from './lib/useQuoteShortcut'
import RequireAuth from './components/RequireAuth'
import RequireAdmin from './components/RequireAdmin'
import ErrorBoundary from './components/ErrorBoundary'
import DesignerSearch from './components/DesignerSearch'
import ChatPopoutHost from './components/ChatPopoutHost'

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
const SetReviewPage = lazyWithRetry(() => import('./pages/SetReviewPage'), 'SetReviewPage')
const SetWorkspacePage = lazyWithRetry(() => import('./pages/SetWorkspacePage'), 'SetWorkspacePage')
const OrderPayPage = lazyWithRetry(() => import('./pages/OrderPayPage'), 'OrderPayPage')
const OrderGroupPayPage = lazyWithRetry(() => import('./pages/OrderGroupPayPage'), 'OrderGroupPayPage')
const DashboardPage = lazyWithRetry(() => import('./pages/DashboardPage'), 'DashboardPage')
const NewProofPage = lazyWithRetry(() => import('./pages/NewProofPage'), 'NewProofPage')
const ProofDetailPage = lazyWithRetry(() => import('./pages/ProofDetailPage'), 'ProofDetailPage')
const NewVersionPage = lazyWithRetry(() => import('./pages/NewVersionPage'), 'NewVersionPage')
const EditVersionPage = lazyWithRetry(() => import('./pages/EditVersionPage'), 'EditVersionPage')
const CustomersPage = lazyWithRetry(() => import('./pages/CustomersPage'), 'CustomersPage')
const CustomerDetailPage = lazyWithRetry(() => import('./pages/CustomerDetailPage'), 'CustomerDetailPage')
const QuotePage = lazyWithRetry(() => import('./pages/QuotePage'), 'QuotePage')
const OrdersPage = lazyWithRetry(() => import('./pages/OrdersPage'), 'OrdersPage')
const OrderLogPage = lazyWithRetry(() => import('./pages/OrderLogPage'), 'OrderLogPage')
const OrderReviewPage = lazyWithRetry(() => import('./pages/OrderReviewPage'), 'OrderReviewPage')
const FeedbackPage = lazyWithRetry(() => import('./pages/FeedbackPage'), 'FeedbackPage')
const ChatPage = lazyWithRetry(() => import('./pages/ChatPage'), 'ChatPage')
const FlaggedPage = lazyWithRetry(() => import('./pages/FlaggedPage'), 'FlaggedPage')
const NotificationSettingsPage = lazyWithRetry(() => import('./pages/NotificationSettingsPage'), 'NotificationSettingsPage')
const AdminLayout = lazyWithRetry(() => import('./pages/admin/AdminLayout'), 'AdminLayout')
const AdminHomePage = lazyWithRetry(() => import('./pages/admin/AdminHomePage'), 'AdminHomePage')
const AdminUsersPage = lazyWithRetry(() => import('./pages/admin/AdminUsersPage'), 'AdminUsersPage')
const AdminPricingPage = lazyWithRetry(() => import('./pages/admin/AdminPricingPage'), 'AdminPricingPage')
const AdminMaterialsPage = lazyWithRetry(() => import('./pages/admin/AdminMaterialsPage'), 'AdminMaterialsPage')
const AdminMaterialEditor = lazyWithRetry(() => import('./pages/admin/AdminMaterialEditor'), 'AdminMaterialEditor')
const AdminAddOnEditor = lazyWithRetry(() => import('./pages/admin/AdminAddOnEditor'), 'AdminAddOnEditor')
const AdminActivityPage = lazyWithRetry(() => import('./pages/admin/AdminActivityPage'), 'AdminActivityPage')
const AdminDemoDataPage = lazyWithRetry(() => import('./pages/admin/AdminDemoDataPage'), 'AdminDemoDataPage')
const AdminOrderLogPage = lazyWithRetry(() => import('./pages/admin/AdminOrderLogPage'), 'AdminOrderLogPage')
const AdminSettingsPage = lazyWithRetry(() => import('./pages/admin/AdminSettingsPage'), 'AdminSettingsPage')
const AdminOutsourcingPage = lazyWithRetry(() => import('./pages/admin/AdminOutsourcingPage'), 'AdminOutsourcingPage')
const AdminContentPage = lazyWithRetry(() => import('./pages/admin/AdminContentPage'), 'AdminContentPage')
const AdminAiDraftsPage = lazyWithRetry(() => import('./pages/admin/AdminAiDraftsPage'), 'AdminAiDraftsPage')
const AdminArtworkCheckPage = lazyWithRetry(() => import('./pages/admin/AdminArtworkCheckPage'), 'AdminArtworkCheckPage')
const AdminCreateMaterialPage = lazyWithRetry(() => import('./pages/admin/AdminCreateMaterialPage'), 'AdminCreateMaterialPage')
const AdminNeedsAttentionPage = lazyWithRetry(() => import('./pages/admin/AdminNeedsAttentionPage'), 'AdminNeedsAttentionPage')
const AdminCatalogueDataPage = lazyWithRetry(() => import('./pages/admin/AdminCatalogueDataPage'), 'AdminCatalogueDataPage')
const AdminAnalyticsPage = lazyWithRetry(() => import('./pages/admin/AdminAnalyticsPage'), 'AdminAnalyticsPage')
const AdminShippingPage = lazyWithRetry(() => import('./pages/admin/AdminShippingPage'), 'AdminShippingPage')
const AdminReorderRegisterPage = lazyWithRetry(() => import('./pages/admin/AdminReorderRegisterPage'), 'AdminReorderRegisterPage')
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
// Reset the window scroll on every forward navigation. Without this the old
// page's scroll offset carries over; when the new page is SHORTER than that
// offset (e.g. dashboard → /chat), iOS leaves the whole web view panned up —
// the "fixed" bottom tab bar visibly breaks away from the screen edge and
// stays there until a manual scroll forces a clamp. Back/forward (POP) is left
// alone so the browser's own position restoration still works.
function ScrollToTopOnNavigate() {
  const { pathname } = useLocation()
  const navigationType = useNavigationType()
  useLayoutEffect(() => {
    if (navigationType !== 'POP') {
      window.scrollTo(0, 0)
      // Below md the app scrolls inside DesignerChrome's frame, not the
      // window — reset that scroller too.
      const frame = document.getElementById('app-scroll')
      if (frame) frame.scrollTop = 0
    }
  }, [pathname, navigationType])
  return null
}

function AppShell() {
  const { recovery, session } = useAuth()
  // The ⌘K command palette. Lives here rather than in DesignerChrome so it is
  // available on every authenticated surface — including the admin shell,
  // which renders its own chrome.
  const [paletteOpen, setPaletteOpen] = useState(false)
  const openPalette = useCallback(() => setPaletteOpen(true), [])
  useDesignerShortcuts(openPalette, !!session)
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
    <TeamChatProvider>
      <ScrollToTopOnNavigate />
      {/* Chat popped out into a picture-in-picture window renders through here.
          Outside <Routes> on purpose: the window has to survive navigating the
          app underneath it. Renders nothing unless that window is open. */}
      {session && <ChatPopoutHost />}
      {session && <DesignerSearch open={paletteOpen} onClose={() => setPaletteOpen(false)} />}
      <RouteErrorBoundary>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
        {/* Public */}
        <Route path="/p/:id" element={<CustomerProofPage />} />
        {/* The bundle review front door (bundle orders Slice 3) — token-gated
            via public_get_proof_set, links into each card's /p/:id page.
            /set/:id is a legacy alias from the pre-rename preview links. */}
        <Route path="/bundle/:id" element={<SetReviewPage />} />
        <Route path="/set/:id" element={<SetReviewPage />} />
        {/* The static /order/group segment outranks /order/:id in React
            Router's matching, so group links never fall into the single-order
            page. */}
        <Route path="/order/group/:id" element={<OrderGroupPayPage />} />
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
        {/* The mobile tab bar's Activity destination — the dashboard's data
            rendered as a page (was a full-screen sheet over the dashboard). */}
        <Route path="/activity" element={<RequireAuth><DashboardPage activityView /></RequireAuth>} />
        <Route path="/quote" element={<RequireAuth><QuotePage /></RequireAuth>} />
        <Route path="/orders" element={<RequireAuth><OrdersPage /></RequireAuth>} />
        {/* The Order log — the searchable archive of every order, with a
            per-order detail view (?order=<id>). Static 'log' outranks the
            :id segment below in React Router's matching. */}
        <Route path="/orders/log" element={<RequireAuth><OrderLogPage /></RequireAuth>} />
        <Route path="/orders/:id/place" element={<RequireAuth><OrderReviewPage /></RequireAuth>} />
        <Route path="/feedback" element={<RequireAuth><FeedbackPage /></RequireAuth>} />
        <Route path="/chat" element={<RequireAuth><ChatPage /></RequireAuth>} />
        <Route path="/flagged" element={<RequireAuth><FlaggedPage /></RequireAuth>} />
        <Route path="/settings/notifications" element={<RequireAuth><NotificationSettingsPage /></RequireAuth>} />
        <Route path="/proofs/new" element={<RequireAuth><NewProofPage /></RequireAuth>} />
        <Route path="/proofs/:id" element={<RequireAuth><ProofDetailPage /></RequireAuth>} />
        {/* The designer bundle workspace (bundle orders Slice 3) — author a
            bundle of cards over one shared customer context. /sets/:id is a
            legacy alias from the pre-rename preview links. */}
        <Route path="/bundles/:id" element={<RequireAuth><SetWorkspacePage /></RequireAuth>} />
        <Route path="/sets/:id" element={<RequireAuth><SetWorkspacePage /></RequireAuth>} />
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
          {/* The /admin landing is a home hub (search + section cards), not a
              redirect into a data page — see AdminHomePage. */}
          <Route index element={<AdminHomePage />} />
          <Route path="analytics" element={<AdminAnalyticsPage />} />
          <Route path="users" element={<AdminUsersPage />} />
          <Route path="customers" element={<CustomersPage />} />
          <Route path="customers/:companyId" element={<CustomerDetailPage />} />
          <Route path="orders" element={<AdminOrderLogPage />} />
          <Route path="reorder-register" element={<AdminReorderRegisterPage />} />
          <Route path="shipping" element={<AdminShippingPage />} />
          <Route path="materials" element={<AdminMaterialsPage />} />
          <Route path="materials/new" element={<AdminCreateMaterialPage />} />
          <Route path="pricing" element={<AdminPricingPage />} />
          <Route path="pricing/materials/:code" element={<AdminMaterialEditor />} />
          <Route path="pricing/add-ons/:code" element={<AdminAddOnEditor />} />
          <Route path="catalogue" element={<Navigate to="/admin/catalogue/lead-times" replace />} />
          <Route path="catalogue/:tab" element={<AdminCatalogueDataPage />} />
          <Route path="content" element={<Navigate to="/admin/content/messages" replace />} />
          <Route path="content/:tab" element={<AdminContentPage />} />
          <Route path="outsourcing" element={<AdminOutsourcingPage />} />
          <Route path="needs-attention" element={<AdminNeedsAttentionPage />} />
          <Route path="ai-drafts" element={<AdminAiDraftsPage />} />
          <Route path="artwork-check" element={<AdminArtworkCheckPage />} />
          <Route path="activity" element={<AdminActivityPage />} />
          <Route path="demo-data" element={<AdminDemoDataPage />} />
          <Route path="settings" element={<AdminSettingsPage />} />

          {/* Old flat-nav URLs (pre the 2026-07 admin nav cleanup) —
              bookmarks and muscle memory keep working via redirects. */}
          <Route path="lead-times" element={<Navigate to="/admin/catalogue/lead-times" replace />} />
          <Route path="card-weights" element={<Navigate to="/admin/catalogue/card-weights" replace />} />
          <Route path="prototype-prices" element={<Navigate to="/admin/catalogue/prototype-prices" replace />} />
          <Route path="xero-item-codes" element={<Navigate to="/admin/catalogue/xero-item-codes" replace />} />
          <Route path="xero-self-test" element={<Navigate to="/admin/catalogue/xero-item-codes" replace />} />
          <Route path="material-options" element={<Navigate to="/admin/catalogue/material-options" replace />} />
          <Route path="core-colours" element={<Navigate to="/admin/catalogue/paper-colours" replace />} />
          <Route path="stranded-approvals" element={<Navigate to="/admin/needs-attention" replace />} />
          <Route path="templates" element={<Navigate to="/admin/content/messages" replace />} />
          <Route path="site-copy" element={<Navigate to="/admin/content/site-copy" replace />} />
          {/* The artwork-check controls moved off Settings to their own tab. */}
          <Route path="settings/artwork-check" element={<Navigate to="/admin/artwork-check" replace />} />
        </Route>
      </Routes>
      </Suspense>
      </RouteErrorBoundary>
    </TeamChatProvider>
  )
}

// Wraps the routes in the crash net, keyed on pathname so navigating away from
// a page that threw clears the error and the app recovers without a reload.
function RouteErrorBoundary({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation()
  return <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>
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
