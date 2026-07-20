import { Suspense } from 'react'
import { Navigate, NavLink, useParams } from 'react-router-dom'
import { lazyWithRetry } from '../../lib/lazyWithRetry'

// /admin/catalogue/:tab — the per-material and per-variant data grids,
// consolidated under one sidebar entry (the 2026-07 admin nav cleanup).
// Each tab was previously its own /admin/* page; the page components
// live on unchanged, minus their page-level headings, and the old URLs
// redirect here from App.tsx. URL-backed tabs (unlike AI drafts' local
// state) so old deep links and bookmarks land on the right grid.
//
// Tabs stay lazy-loaded so each keeps its own chunk — the paper-colours
// grid pulls in the ~400 kB xlsx library for its import/export, and a
// static import here would ship that to every catalogue visit (the
// PR #392 bundle regression all over again).
//
// House rule: a NEW per-material / per-variant value becomes a new tab
// here — not a new sidebar entry.
const AdminLeadTimesPage = lazyWithRetry(() => import('./AdminLeadTimesPage'), 'AdminLeadTimesPage')
const AdminCardWeightsPage = lazyWithRetry(() => import('./AdminCardWeightsPage'), 'AdminCardWeightsPage')
const AdminPrototypePricesPage = lazyWithRetry(() => import('./AdminPrototypePricesPage'), 'AdminPrototypePricesPage')
const AdminXeroItemCodesPage = lazyWithRetry(() => import('./AdminXeroItemCodesPage'), 'AdminXeroItemCodesPage')
const AdminXeroSelfTestPage = lazyWithRetry(() => import('./AdminXeroSelfTestPage'), 'AdminXeroSelfTestPage')
const AdminMaterialOptionsPage = lazyWithRetry(() => import('./AdminMaterialOptionsPage'), 'AdminMaterialOptionsPage')
const AdminCoreColoursPage = lazyWithRetry(() => import('./AdminCoreColoursPage'), 'AdminCoreColoursPage')
const AdminStockMaterialsPage = lazyWithRetry(() => import('./AdminStockMaterialsPage'), 'AdminStockMaterialsPage')

const TABS: { slug: string; label: string }[] = [
  { slug: 'lead-times', label: 'Lead times' },
  { slug: 'card-weights', label: 'Card weights' },
  { slug: 'prototype-prices', label: 'Prototype prices' },
  { slug: 'xero-item-codes', label: 'Xero item codes' },
  { slug: 'material-options', label: 'Material options' },
  { slug: 'paper-colours', label: 'Paper colours' },
  { slug: 'stock-materials', label: 'Stock materials' },
]

export default function AdminCatalogueDataPage() {
  const { tab } = useParams()
  if (!TABS.some((t) => t.slug === tab)) {
    return <Navigate to="/admin/catalogue/lead-times" replace />
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-ink">Catalogue data</h2>
        <p className="mt-1 text-sm text-ink-mute">
          The reference figures recorded against each material and variant — production, shipping, accounting, and the choices offered within a material. The app reads these live, so a change here applies immediately with no redeploy.
        </p>
      </div>

      {/* Tabs — same visual pattern as the AI drafts page, but URL-backed */}
      <div className="flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t) => (
          <NavLink
            key={t.slug}
            to={`/admin/catalogue/${t.slug}`}
            className={({ isActive }) =>
              [
                'whitespace-nowrap px-3 py-2 text-sm border-b-2 -mb-px transition-colors',
                isActive ? 'border-[var(--c-brand)] text-ink font-medium' : 'border-transparent text-ink-mute hover:text-ink',
              ].join(' ')
            }
          >
            {t.label}
          </NavLink>
        ))}
      </div>

      {/* Local Suspense so the heading + tab strip stay put while a
          tab's chunk loads, instead of bubbling to the route-level
          boundary and blanking the whole page. */}
      <Suspense fallback={<p className="py-8 text-center text-sm text-ink-mute">Loading…</p>}>
        {tab === 'lead-times' && <AdminLeadTimesPage />}
        {tab === 'card-weights' && <AdminCardWeightsPage />}
        {tab === 'prototype-prices' && <AdminPrototypePricesPage />}
        {tab === 'xero-item-codes' && (
          <>
            <AdminXeroItemCodesPage />
            {/* The self-test verifies the codes above resolve correctly in
                Xero, so it lives directly below them — run it right after
                editing. Previously its own /admin/xero-self-test page. */}
            <div className="border-t border-line pt-6">
              <AdminXeroSelfTestPage />
            </div>
          </>
        )}
        {tab === 'material-options' && <AdminMaterialOptionsPage />}
        {tab === 'paper-colours' && <AdminCoreColoursPage />}
        {tab === 'stock-materials' && <AdminStockMaterialsPage />}
      </Suspense>
    </div>
  )
}
