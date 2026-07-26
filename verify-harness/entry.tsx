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
import ProofDetailPage from '../src/pages/ProofDetailPage'
import { ProofDetailView } from '../src/components/ProofDetailView'
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
import AdminDemoDataPage from '../src/pages/admin/AdminDemoDataPage'
import { SpreadQuoteResults } from '../src/components/quote/SpreadQuoteResults'
import { RecapArtwork, buildRecapTiles } from '../src/components/ArtworkFade'
import ArtworkCheckReportView, { type ArtworkCheckReport } from '../src/components/ArtworkCheckReportView'
import VersionPreviewGate from '../src/components/VersionPreviewGate'
import { ProofAnnotationEditor } from '../src/components/ProofAnnotationEditor'
import Modal from '../src/components/Modal'
import { ButtonGhost } from '../src/design'
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

// ?path=/artwork-report mounts the shared artwork-check report card on its own
// with a representative report (a defect flag, a review flag, an unpicked
// correction, notes, reference gaps, and a comparison table) so the
// glanceability formatting can be eyeballed without a live edge-function run.
// Left column = the review-page treatment (Re-run action); right = the
// Orders-page archive modal treatment (no action).
//
// ?path=/artwork-report-modal mounts the REAL Modal with a deliberately long
// report (the header/body/footer structure copied verbatim from OrdersPage) so
// the "long report breaches the top/bottom of the screen with no scroll" fix
// can be verified — the panel must cap at 85vh with the report scrolling
// between a pinned label and a pinned Close.
const ARTWORK_REPORT_FIXTURE: ArtworkCheckReport = {
  verdict: 'defect',
  summary:
    'Checked the two printed cards against the Help Scout thread and the approved proof. One name looks wrong outright and one correction the customer sent hasn’t been picked up; a couple of smaller things are worth a glance.',
  cards: [
    {
      label: 'Front — Sarah Whitehall',
      findings: [
        { field: 'name', supplied: 'Sarah Whitehall', printed: 'Sara Whitehall', status: 'flag', severity: 'defect', note: 'Missing the “h” — the customer signs off “Sarah” throughout the thread.' },
        { field: 'job_title', supplied: 'Managing Director', printed: 'Managing Director', status: 'match', note: '' },
        { field: 'email', supplied: 'sarah@whitehall.capital', printed: 'sarah@whitehall.capital', status: 'match', note: '' },
        { field: 'phone', supplied: '', printed: '+44 20 7946 0102', status: 'not_supplied', note: '' },
      ],
    },
    {
      label: 'Back — logo side',
      findings: [
        { field: 'website', supplied: 'whitehall.capital', printed: 'whitehallcapital.com', status: 'flag', severity: 'review', note: 'Domain differs from the one in the signature — may be intentional, worth a glance.' },
        { field: 'tagline', supplied: 'Private capital, personally managed', printed: 'Private capital, personally managed', status: 'match', note: '' },
      ],
    },
  ],
  corrections: [
    { quote: 'Actually please make my title “Founder & CEO”, not Managing Director.', resolved: false, severity: 'defect', note: 'Sent 14 Jul; the printed card still reads Managing Director.' },
  ],
  notes: [
    'Both cards use the Stainless Steel finish the customer approved on v3.',
    'The QR on the front decodes to the vCard URL that matches the approved proof.',
  ],
  reference_gaps: [
    'No phone number was supplied in the thread, so the printed number couldn’t be verified.',
  ],
  checked_at: '2026-07-23T09:14:00.000Z',
}
function ArtworkReportRig() {
  return (
    <div className="min-h-screen bg-canvas">
      <div className="mx-auto grid max-w-5xl gap-6 px-4 py-10 lg:grid-cols-2">
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-mute">Place-order review card</p>
          {/* Mirrors the live card treatment for a defect verdict: neutral
              surface + slim verdict outline (the solid wash is gone — it made
              every table row read as flagged). */}
          <div className="rounded-lg bg-surface px-3.5 py-3 ring-1 ring-[var(--c-out)]/50">
            <ArtworkCheckReportView
              report={ARTWORK_REPORT_FIXTURE}
              action={<button type="button" className="text-[13px] font-medium text-brand hover:underline">Re-run</button>}
            />
          </div>
        </div>
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-mute">Orders-page archive modal</p>
          <div className="rounded-lg border border-line bg-surface p-5 shadow-sm">
            <p className="text-[11px] font-medium uppercase tracking-wide text-ink-mute">Order 403910 · Whitehall Capital</p>
            <div className="mt-2">
              <ArtworkCheckReportView report={ARTWORK_REPORT_FIXTURE} />
            </div>
            <div className="mt-4 flex justify-end">
              <ButtonGhost size="sm">Close</ButtonGhost>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// A report long enough to overflow a desktop viewport — the Boat Shack-style
// case Rob hit, where the modal spilled off the top and bottom with no scroll.
const ARTWORK_REPORT_LONG: ArtworkCheckReport = {
  verdict: 'flagged',
  summary:
    '2 to review: unverifiable QR payload, and email domain (boat-shack.com) differs from the website (boatshackutah.com); also flag the cut-through header vs the customer’s ‘keep full card intact’ request.',
  cards: [
    {
      label: 'Chris Azevedo — front/back',
      findings: [
        { field: 'email', supplied: '', printed: 'chris@boat-shack.com', status: 'flag', severity: 'review', note: 'no email supplied in thread; domain boat-shack.com differs from the printed website boatshackutah.com and from the account email chrisazevedo8@gmail.com — worth confirming, but was approved in the proof' },
        { field: 'qr', supplied: '', printed: 'QR code present on back', status: 'flag', severity: 'review', note: 'no stored payload to verify — scan-test before print' },
        { field: 'name', supplied: 'Chris Azevedo', printed: 'Chris Azevedo', status: 'match', note: '' },
        { field: 'phone', supplied: '801 555 0142', printed: '801 555 0142', status: 'match', note: '' },
        { field: 'second_number', supplied: '', printed: '801 555 0199', status: 'not_supplied', note: '' },
        { field: 'website', supplied: '', printed: 'boatshackutah.com', status: 'not_supplied', note: '' },
        { field: 'address', supplied: '', printed: '128 Marina Way, Salt Lake City', status: 'not_supplied', note: '' },
        { field: 'job_title', supplied: 'Owner', printed: 'Owner', status: 'match', note: '' },
      ],
    },
  ],
  corrections: [],
  notes: [
    'Back is not mirrored — correct here, because the customer requested full card intact (no cutout), so the usual cut-through mirroring does not apply.',
    'Print files match the approved proof (front logo/website; back name, email, both numbers, QR, address) — no post-approval drift detected.',
  ],
  reference_gaps: [
    'Order header states ‘cut-through construction: YES’, which conflicts with the customer’s explicit request to ‘keep full card intact instead of doing the cutout section’ — confirm the actual construction with production (cannot be fully verified from print files).',
    'No email/website/address/second-number values were re-supplied in this reorder thread; printed values carried over from prior artwork and recorded as not_supplied.',
    'QR payload not stored on this proof version — contents could not be checked.',
  ],
  checked_at: '2026-07-22T09:49:00.000Z',
}
// The header/body/footer structure here is copied verbatim from OrdersPage's
// artworkReportModal block — keep them identical so this rig faithfully tests
// the real layout.
function ArtworkReportModalRig() {
  return (
    <div className="min-h-screen bg-canvas">
      <div className="mx-auto max-w-5xl px-4 py-10 text-ink-mute">Orders page (behind the modal)</div>
      <Modal open onClose={() => {}} ariaLabel="Artwork check report" panelClassName="w-full max-w-xl rounded-2xl bg-white shadow-xl md:flex md:max-h-[85vh] md:flex-col">
        <div className="shrink-0 px-5 pt-5 pb-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-ink-mute">Order 403910 · The Boat Shack</p>
        </div>
        <div className="px-5 text-[13px] text-ink md:min-h-0 md:flex-1 md:overflow-y-auto">
          <ArtworkCheckReportView report={ARTWORK_REPORT_LONG} />
        </div>
        <div className="mt-1 flex shrink-0 justify-end border-t border-line-soft px-5 py-3">
          <ButtonGhost size="sm">Close</ButtonGhost>
        </div>
      </Modal>
    </div>
  )
}

// ?path=/preview-gate mounts the post-save VersionPreviewGate with fixture
// ids so the banner layout — review checklist + the pre-send proof-check
// chip (settings fixture has proof_check_enabled: true) — can be checked
// without saving a real version. The iframe target doesn't resolve to a real
// customer page here; the gate treats that as "Loading preview…", which is
// fine for banner checks.
// ?path=/detail-markers mounts the zoom/detail viewer with two designer
// callouts marked on the artwork (migration 000347). This is the one customer
// surface where a marker may sit ON the card, so it needs its own rig: the
// transform moved from the <img> onto a wrapper to carry the markers, and
// clampTranslate() / applyScaleAround() still read imgRef's rect to recover the
// unscaled size. Pinch, double-tap and pan must behave exactly as before.
const MARKER_RIG_CARD =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 428 270'%3E%3Crect width='428' height='270' rx='14' fill='%23d5d2cc'/%3E%3Ccircle cx='58' cy='52' r='17' fill='none' stroke='%23322e29' stroke-width='2.4'/%3E%3Ctext x='40' y='214' font-family='sans-serif' font-size='23' fill='%231d1a17'%3ENolan Bushnell%3C/text%3E%3Ctext x='40' y='235' font-family='sans-serif' font-size='11.5' fill='%234a453e'%3EFOUNDER%3C/text%3E%3C/svg%3E"

function DetailMarkersRig() {
  const images = [
    {
      id: 'img-front',
      signed_url: MARKER_RIG_CARD,
      side: 'front' as const,
      associated_name: 'Nolan Bushnell',
      original_filename: 'nolan-front.svg',
    },
    {
      id: 'img-back',
      signed_url: MARKER_RIG_CARD,
      side: 'back' as const,
      associated_name: 'Nolan Bushnell',
      original_filename: 'nolan-back.svg',
    },
  ]
  return (
    <div className="relative h-dvh w-full bg-canvas">
      <ProofDetailView
        images={images}
        initialIndex={0}
        displayLabel="Nolan Bushnell"
        close={() => {}}
        onRequestChanges={() => {}}
        hideRequestChanges={false}
        panelOpen={false}
        markersByImageId={{
          'img-front': [
            { id: 'c1', x: 0.14, y: 0.19 },
            { id: 'c2', x: 0.16, y: 0.84 },
          ],
        }}
      />
    </div>
  )
}

// ?path=/customer-pins mounts the DESIGNER half of the pin feature (migration
// 000347) — the surface a designer opens to see where the customer pointed.
// It needs its own rig because you cannot sign in headlessly, so this is the
// only way to click-test the four things that make the feature work at all:
// blue numbered dots sitting on the placed coordinates, dot numbers matching
// the checklist rows, "Show me where" switching to the pin's own side, and a
// tick turning that pin green.
//
// The fixture pins share one created_at on purpose (proof-action writes both in
// a single insert), so the ordering tie-break is exercised rather than assumed.
function CustomerPinsRig() {
  return (
    <ProofAnnotationEditor
      open
      onClose={() => {}}
      versionId="demo-version"
      versionNumber={11}
      userId="user-rob"
    />
  )
}

function PreviewGateRig() {
  return (
    <VersionPreviewGate
      proofId="demo-proof"
      versionId="demo-version"
      versionNumber={3}
      currency="GBP"
      onConfirm={() => {}}
      onEdit={() => {}}
      confirmLabel="Looks good — write the reply"
    />
  )
}

function Elsewhere() {
  return <div style={{ padding: 40 }} data-nav-target>navigated away</div>
}

function Stub() {
  return <div style={{ padding: 40 }} data-nav-target>stub admin page</div>
}

// ?path=/… is the canonical form, but some embedded preview panes strip the
// query string on navigation, so #/… is accepted as an equivalent fallback.
const requestedPath =
  new URLSearchParams(window.location.search).get('path') ||
  (window.location.hash ? window.location.hash.replace(/^#/, '') : null)

// ?path=/palette mounts the ⌘K designer command palette on its own, open, so
// its layout and the fixture-backed proof search can be checked headlessly.
const tree = requestedPath === '/detail-markers' ? (
  <DetailMarkersRig />
) : requestedPath === '/customer-pins' ? (
  <CustomerPinsRig />
) : requestedPath === '/quote-spread' ? (
  <QuoteSpreadRig />
) : requestedPath === '/recap-zoom' ? (
  <RecapZoomRig />
) : requestedPath === '/artwork-report' ? (
  <ArtworkReportRig />
) : requestedPath === '/artwork-report-modal' ? (
  <ArtworkReportModalRig />
) : requestedPath === '/preview-gate' ? (
  <PreviewGateRig />
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
        <Route path="demo-data" element={<AdminDemoDataPage />} />
        <Route path="*" element={<Stub />} />
      </Route>
      <Route path="*" element={<Elsewhere />} />
    </Routes>
  </MemoryRouter>
) : requestedPath?.startsWith('/proofs/') ? (
  // ?path=/proofs/p-a1 — the proof detail page against the approved fixture
  // project (use an id containing 'open', e.g. /proofs/p-open, for the
  // in_progress branch). Used to verify the header overflow menu (Duplicate
  // project) + its confirm dialog.
  <MemoryRouter initialEntries={[requestedPath]}>
    <Routes>
      <Route path="/proofs/:id" element={<ProofDetailPage />} />
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

// Log uncaught render errors with their real message + component stack —
// React's default logging flattens the Error into a %s placeholder, which
// headless console readers can't recover.
createRoot(document.getElementById('root')!, {
  onUncaughtError: (error, errorInfo) => {
    console.error('[harness] uncaught render error:', error, errorInfo?.componentStack ?? '')
  },
}).render(<StrictMode>{tree}</StrictMode>)
