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
import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import OrdersPage from '../src/pages/OrdersPage'
import OrderLogPage from '../src/pages/OrderLogPage'
import OrderReviewPage from '../src/pages/OrderReviewPage'
import ProofDetailPage from '../src/pages/ProofDetailPage'
import CustomerProofPage from '../src/pages/CustomerProofPage'
import OrderPayPage from '../src/pages/OrderPayPage'
import OrderGroupPayPage from '../src/pages/OrderGroupPayPage'
import NewVersionPage from '../src/pages/NewVersionPage'
import EditVersionPage from '../src/pages/EditVersionPage'
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
import AdminAnalyticsPage from '../src/pages/admin/AdminAnalyticsPage'
import AdminSettingsPage from '../src/pages/admin/AdminSettingsPage'
import AdminArtworkCheckPage from '../src/pages/admin/AdminArtworkCheckPage'
import AdminDemoDataPage from '../src/pages/admin/AdminDemoDataPage'
import { SpreadQuoteResults } from '../src/components/quote/SpreadQuoteResults'
import { RecapArtwork, buildRecapTiles } from '../src/components/ArtworkFade'
import ArtworkCheckReportView, { type ArtworkCheckReport } from '../src/components/ArtworkCheckReportView'
import VersionPreviewGate from '../src/components/VersionPreviewGate'
import { ProofAnnotationEditor } from '../src/components/ProofAnnotationEditor'
import Modal from '../src/components/Modal'
import ContactNameNudge from '../src/components/ContactNameNudge'
import AbandonProjectDialog from '../src/components/AbandonProjectDialog'
import BundleCheckpoint from '../src/components/BundleCheckpoint'
import { buildBundleCheckpoint, type CheckpointMember, type CheckpointVersion } from '../src/lib/bundleCheckpoint'
import EditCustomerDialog from '../src/components/EditCustomerDialog'
import ApprovedOrderStatus from '../src/components/ApprovedOrderStatus'
import OrderBuilderModal from '../src/components/OrderBuilderModal'
import { StatusRule } from '../src/design'
import { orderStatusLine, reorderForwardLink, type OrderStatusLine, type ProofOrderStatePayload } from '../src/lib/proofOrderState'
import { ReorderForwardPanel, ReorderPanel, type ReorderState } from '../src/components/ReorderPanel'
import ReorderDeskPanel from '../src/components/ReorderDeskPanel'
import { REORDER_COPY } from '../src/lib/proofOrderState'
import type { TrackingStage } from '../src/lib/orderTracking'
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


// ?path=/artwork-report-cutthrough mounts the report as it looks when the
// cut-through check finds a piece of metal that would fall out. The two
// cut-through rows are the EXACT strings applyCutThroughFindings emits for the
// real Skyfall 403813 files (the 'P' of "P4:13"), so this rig shows what a
// live report actually renders, not an approximation. The surrounding
// contact-field rows are representative model output.
const ARTWORK_REPORT_CUTTHROUGH: ArtworkCheckReport = {
  verdict: 'defect',
  summary:
    'The middle of the “P” in “P4:13” is cut clean through with nothing holding it on, so it would drop out at the supplier. Every printed detail matches what the customer supplied.',
  cards: [
    {
      label: 'Gianpaolo Frigo — 02_GianpaoloFrigo_BM.ai',
      findings: [
        { field: 'other', supplied: 'a strut holding every cut-out middle on', printed: '1 cut-out middle is not attached — 2.19 mm² at (220.5, 30) pt', status: 'flag', severity: 'defect', note: 'Cut clean through the card with no strut holding it on, so it would drop out at the supplier. The same hole is on both faces. Measured from the print file, not read off the artwork.' },
        { field: 'name', supplied: 'Gianpaolo Frigo (request form)', printed: 'Gianpaolo Frigo', status: 'match', note: '' },
        { field: 'company', supplied: 'Skyfall Intelligence Agency (request form)', printed: 'Skyfall Intelligence Agency', status: 'match', note: '' },
        { field: 'email', supplied: 'paolo@skyfallintelligenceagency.com (request form)', printed: 'paolo@skyfallintelligenceagency.com', status: 'match', note: '' },
        { field: 'tel', supplied: '+353 1 254 8000 (customer reply, 24 Jun)', printed: '+353 1 254 8000', status: 'match', note: '' },
      ],
    },
  ],
  corrections: [],
  notes: [
    'The back reads reversed because the design cuts right through the card.',
    'The print files match the proof the customer approved.',
  ],
  reference_gaps: [],
  checks: [
    { key: 'cut_through', label: 'Loose pieces', outcome: 'flagged', detail: '2 card faces measured. 1 cut-out piece is not held on — flagged above.' },
  ],
  checked_at: '2026-07-27T11:04:00.000Z',
}

// The amber sibling: only one side of the card was supplied, so we cannot tell
// a cut-through from printed white. Strings are exactly what the code emits
// for BMW of Dublin 403920.
const ARTWORK_REPORT_CUTTHROUGH_MAYBE: ArtworkCheckReport = {
  verdict: 'flagged',
  summary:
    'Only one side of this card was supplied, so we could not confirm whether the roundel is cut through or printed. Everything printed matches what the customer supplied.',
  cards: [
    {
      label: 'Owais Deura — 02.ai',
      findings: [
        { field: 'other', supplied: 'a strut holding every cut-out middle on', printed: '4 cut-out middles would come away IF this white is cut through — 48.28 mm² at (21, 100.8) pt; 2.382 mm² at (29, 123.6) pt; 2.341 mm² at (40.1, 117.8) pt; 2.3 mm² at (17.5, 117.8) pt', status: 'flag', severity: 'review', note: 'Only one side of this card was supplied, so we cannot tell whether the white is cut through or printed. If it is cut, these pieces would fall out.' },
        { field: 'name', supplied: 'Owais Deura (request form)', printed: 'Owais Deura', status: 'match', note: '' },
        { field: 'company', supplied: 'BMW of Dublin (request form)', printed: 'BMW of Dublin', status: 'match', note: '' },
      ],
    },
  ],
  corrections: [],
  notes: [],
  reference_gaps: [],
  checks: [
    { key: 'cut_through', label: 'Loose pieces', outcome: 'flagged', detail: '1 card face measured. The other side is missing, so one card’s cut-outs can’t be settled — flagged above.' },
  ],
  checked_at: '2026-07-27T11:04:00.000Z',
}

// The state the check used to be SILENT on, and the reason "Checks run" exists
// (Rob, 2026-08-02): the cut-outs were measured and every one is held on. From
// the report alone a reviewer previously could not tell this apart from the
// check never having run. Strings verbatim from summariseCutThrough.
const ARTWORK_REPORT_CUTTHROUGH_PASS: ArtworkCheckReport = {
  verdict: 'clear',
  summary: 'Every printed detail matches what the customer supplied, and every piece cut through the card is held on.',
  cards: [
    {
      label: 'Marcus Kane — 01_Front.ai / 01_Back.ai',
      findings: [
        { field: 'name', supplied: 'Marcus Kane (request form)', printed: 'Marcus Kane', status: 'match', note: '' },
        { field: 'company', supplied: 'Kane Joinery (request form)', printed: 'Kane Joinery', status: 'match', note: '' },
        { field: 'email', supplied: 'marcus@kanejoinery.co.uk (request form)', printed: 'marcus@kanejoinery.co.uk', status: 'match', note: '' },
        { field: 'mob', supplied: '07700 900412 (customer reply, 2 Jul)', printed: '07700 900412', status: 'match', note: '' },
      ],
    },
  ],
  corrections: [],
  notes: ['The back reads reversed because the design cuts right through the card.'],
  reference_gaps: [],
  checks: [
    { key: 'cut_through', label: 'Loose pieces', outcome: 'passed', detail: '2 card faces measured. No cut-out piece would come loose at the supplier.' },
  ],
  checked_at: '2026-08-02T10:20:00.000Z',
}

function ArtworkReportCutThroughRig() {
  return (
    <div className="min-h-screen bg-canvas">
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-10 lg:grid-cols-3">
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-mute">Red — a piece would fall out</p>
          <div className="rounded-lg bg-surface px-3.5 py-3 ring-1 ring-[var(--c-out)]/50">
            <ArtworkCheckReportView
              report={ARTWORK_REPORT_CUTTHROUGH}
              action={<button type="button" className="text-[13px] font-medium text-brand hover:underline">Re-run</button>}
            />
          </div>
        </div>
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-mute">Amber — one side only, so unconfirmed</p>
          <div className="rounded-lg bg-surface px-3.5 py-3 ring-1 ring-[var(--c-out)]/50">
            <ArtworkCheckReportView
              report={ARTWORK_REPORT_CUTTHROUGH_MAYBE}
              action={<button type="button" className="text-[13px] font-medium text-brand hover:underline">Re-run</button>}
            />
          </div>
        </div>
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-mute">Green — measured and held on</p>
          <div className="rounded-lg bg-surface px-3.5 py-3 ring-1 ring-[var(--c-in-stock)]/40">
            <ArtworkCheckReportView
              report={ARTWORK_REPORT_CUTTHROUGH_PASS}
              action={<button type="button" className="text-[13px] font-medium text-brand hover:underline">Re-run</button>}
            />
          </div>
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
  // "Ran, and there was nothing for it to check" — deliberately NOT dressed up
  // as a pass, since there are no cut-outs to be held on.
  checks: [
    { key: 'cut_through', label: 'Loose pieces', outcome: 'not_applicable', detail: '2 card faces measured. Nothing is cut through these cards, so no piece can come loose.' },
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

// ?path=/contact-name-nudge — the first-name-only prompt in every state it can
// reach, using the real live contacts that prompted it (2026-07-29 audit).
// Pure props, so no fixture data is needed. The order below is the point: the
// two "silent" rows must render nothing at all.
function ContactNameNudgeRig() {
  const rows: Array<{ label: string; el: ReactNode }> = [
    {
      label: 'Help Scout has a fuller name (the Karen Law case)',
      el: (
        <ContactNameNudge
          fullName="Karen" email="karen.law@limiai.co" helpscoutName="Karen Law"
          onApply={() => {}}
        />
      ),
    },
    {
      label: 'Surname read off the email address (lower confidence, says so)',
      el: (
        <ContactNameNudge
          fullName="Caleb" email="calebhozan16@gmail.com" onApply={() => {}}
        />
      ),
    },
    {
      label: 'Editing, no suggestion available — warns anyway',
      el: (
        <ContactNameNudge
          fullName="Sam" email="sami69@mac.com" onApply={() => {}} warnWithoutSuggestion
        />
      ),
    },
    {
      label: 'Saving, and a failed write',
      el: (
        <ContactNameNudge
          fullName="Kane" email="kane_adams@ymail.com" onApply={() => {}}
          busy error="Couldn't update the name: permission denied"
        />
      ),
    },
    {
      label: 'SILENT — staging surface with nothing to offer',
      el: <ContactNameNudge fullName="Karan" email="karan@servicewing.com" onApply={() => {}} />,
    },
    {
      label: 'PILL, nothing to suggest — warns and offers an inline field',
      el: (
        <ContactNameNudge
          fullName="Karan" email="karan@servicewing.com" onApply={() => {}}
          warnWithoutSuggestion allowEdit
        />
      ),
    },
    {
      label: 'PILL, suggestion present — accept as-is or adjust the cruft first',
      el: (
        <ContactNameNudge
          fullName="Andrea" email="andreaegidio@beyond-group.it"
          helpscoutName="Andrea Egidio Marazzi - Beyond Group"
          onApply={() => {}} warnWithoutSuggestion allowEdit
        />
      ),
    },
    {
      label: 'SILENT — name already has a surname',
      el: (
        <ContactNameNudge
          fullName="Karen Law" email="karen.law@limiai.co" onApply={() => {}} warnWithoutSuggestion
        />
      ),
    },
  ]
  return (
    <div className="min-h-screen bg-canvas p-10">
      <div className="mx-auto max-w-lg space-y-6">
        {rows.map((r) => (
          <div key={r.label}>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-mute">
              {r.label}
            </p>
            <div className="rounded-lg border border-dashed border-line bg-surface p-3">{r.el}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ?path=/abandon-dialog — the Abandon-project confirm. Pass
// ?state=silent|blocked|sent (default silent):
//   silent  — the DEFAULT path, which must stay indistinguishable from the
//             plain confirm this replaced. Click the checkbox to see the
//             opt-in state with the editable message.
//   blocked — the notify option can't be offered (no linked conversation) and
//             explains itself instead of failing at send time.
//   retry   — the project closed but its notice failed to send. The dialog
//             stops offering to close anything and becomes a retry of the
//             message alone, so nothing claims the project is still open.
// The template body comes from the fixture supabase client, which returns no
// row, so the dialog falls back to DEFAULT_BODIES — the copy a fresh install
// ships with.
function AbandonDialogRig() {
  const state = new URLSearchParams(window.location.search).get('state') ?? 'silent'
  const blocked = state === 'blocked'
  return (
    <div className="min-h-screen bg-canvas">
      <AbandonProjectDialog
        contactName="Takashi Yamada"
        companyName="Yanko Design"
        blocker={
          blocked
            ? {
                code: 'no_conversation',
                detail:
                  'No Help Scout conversation is linked to this project, so there’s no thread to post on. Link one first, or message the customer yourself.',
              }
            : null
        }
        working={false}
        errorMsg={
          state === 'retry' ? 'Help Scout conversation not found' : null
        }
        closedPendingNotice={state === 'retry'}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
      <p className="p-6 text-xs text-ink-mute">
        state={state} — try ?state=blocked, ?state=retry. Tick the box for the notify state.
      </p>
    </div>
  )
}

// ?path=/bundle-checkpoint — the post-save bundle checkpoint (the "one email
// per revision round" routing fix). Pass ?state=midround|ready|unsent
// (default midround):
//   midround — the Experience Auto Group shape mid-round: this card just
//              revised, one sibling revised earlier, one still holding only
//              what the customer has seen, one unbuilt shell. Primary must
//              steer back to the bundle.
//   ready    — every card carries unannounced changes: primary flips to the
//              single bundle send (plus a ghost back-to-bundle).
//   unsent   — a draft bundle mid-build (two shells remain).
// The model goes through the real buildBundleCheckpoint, so the rig
// exercises classification as well as markup.
function BundleCheckpointRig() {
  const state = new URLSearchParams(window.location.search).get('state') ?? 'midround'
  const SENT = '2026-07-01T09:00:00Z'
  const v = (
    id: string,
    n: number,
    sent: string | null,
    mat: string,
    names: string[] = [],
  ): CheckpointVersion => ({ id, version_number: n, material_display: mat, names, last_reply_sent_at: sent })
  const m = (proofId: string, cv: CheckpointVersion | null): CheckpointMember => ({
    proof_id: proofId,
    status: 'in_progress',
    set_discarded_at: null,
    current_version: cv,
  })
  const members: CheckpointMember[] =
    state === 'ready'
      ? [
          m('p1', v('v1b', 2, null, 'Stainless Steel', ['James Milner'])),
          m('p2', v('v2b', 2, null, 'Carbon Fibre', ['Andy Robertson'])),
          m('p3', v('v3b', 3, null, 'Letterpress')),
        ]
      : state === 'unsent'
        ? [m('p1', v('v1a', 1, null, 'Stainless Steel', ['James Milner'])), m('p2', null), m('p3', null)]
        : [
            m('p1', v('v1b', 2, null, 'Stainless Steel', ['James Milner'])),
            m('p2', v('v2b', 2, null, 'Carbon Fibre', ['Andy Robertson'])),
            m('p3', v('v3a', 1, SENT, 'Letterpress')),
            m('p4', null),
          ]
  const model = buildBundleCheckpoint({
    members,
    savedProofId: 'p1',
    savedVersionId: state === 'unsent' ? 'v1a' : 'v1b',
    setSentAt: state === 'unsent' ? null : SENT,
  })
  return (
    <MemoryRouter>
      <div className="min-h-screen bg-canvas p-6">
        <div className="mx-auto max-w-2xl">
          {model ? (
            <BundleCheckpoint
              model={model}
              setId="set-1"
              customerLabel="Experience Auto Group"
              onSendJustThisCard={() => {}}
            />
          ) : (
            <p className="text-sm text-rose-700">builder returned null — the rig fixture is wrong</p>
          )}
          <p className="p-6 text-xs text-ink-mute">state={state} — try ?state=ready, ?state=unsent.</p>
        </div>
      </div>
    </MemoryRouter>
  )
}

// ?path=/edit-customer-dialog — the pencil-on-the-proof-header dialog
// (company + contact correction at the point of need). Pass
// ?state=nocompany for a contact with no company (the company field is
// omitted rather than offering a rename of nothing), ?state=admin for
// the admin-only "Open in Admin → Customers" footer link. The fixture
// client's update() resolves with no row, so clicking Save exercises
// the failure copy.
function EditCustomerDialogRig() {
  const state = new URLSearchParams(window.location.search).get('state') ?? 'designer'
  const noCompany = state === 'nocompany'
  return (
    <MemoryRouter>
      <div className="min-h-screen bg-canvas">
        <EditCustomerDialog
          contactId="contact-1"
          companyId={noCompany ? null : 'company-1'}
          current={{
            companyName: noCompany ? null : 'Harbour design interiors ltd',
            contactName: 'Shane Collins',
            contactEmail: 'shane@harbourdesigninteriors.com',
          }}
          isAdmin={state === 'admin'}
          onSaved={() => {}}
          onClose={() => {}}
        />
        <p className="p-6 text-xs text-ink-mute">
          state={state} — try ?state=nocompany, ?state=admin.
        </p>
      </div>
    </MemoryRouter>
  )
}

// ?path=/approved-order-status — the approved card on /p/:id in every
// post-approval state, under the real .customer-accent scope so the approved
// token resolves to the customer-page green rather than the designer one.
//
// Two things to look at: the colour (000371 moved it off the cyan it had been
// deepened to, back into a conventional green at equal legibility), and the
// step count — a DPD parcel gets a three-step rail that COMPLETES, because DPD
// has never once reported a delivery, while a FedEx one keeps the fourth step
// it can actually reach.
function ApprovedOrderStatusRig() {
  useEffect(() => {
    document.documentElement.classList.add('customer-accent')
    return () => document.documentElement.classList.remove('customer-accent')
  }, [])
  const rows: Array<{ label: string; status: OrderStatusLine | null }> = [
    { label: 'Approved, no order yet — card unchanged from before', status: null },
    { label: 'Awaiting payment', status: orderStatusLine(mkState('awaiting_payment')) },
    { label: 'Paid, tracking off / job cancelled', status: orderStatusLine(mkState('paid')) },
    { label: 'Paid — step 1 of 4', status: orderStatusLine(mkState('paid', 'paid')) },
    { label: 'In production', status: orderStatusLine(mkState('paid', 'in_production')) },
    { label: 'On its way — FedEx, 4 steps, still travelling (present tense)', status: orderStatusLine(mkState('paid', 'on_its_way', true, SHIPPED_AT)) },
    { label: 'Shipped — DPD, 3 steps and COMPLETE (past tense + date, 000375)', status: orderStatusLine(mkState('paid', 'on_its_way', false, SHIPPED_AT)) },
    { label: 'Shipped — DPD with no dispatch stamp recorded (past tense, no date)', status: orderStatusLine(mkState('paid', 'on_its_way', false, null)) },
    { label: 'Delivered', status: orderStatusLine(mkState('paid', 'delivered', true)) },
  ]
  return (
    <div className="min-h-screen bg-canvas p-8">
      <div className="mx-auto flex max-w-[380px] flex-col gap-6">
        {rows.map((r) => (
          <div key={r.label}>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-mute">
              {r.label}
            </p>
            {/* Mirrors the approved card's own chrome so the status footer is
                judged in the setting it actually ships in. */}
            <div
              className="relative rounded-[14px] bg-in-stock-soft px-5 py-4 shadow-card"
              style={{ border: '1px solid color-mix(in srgb, var(--c-in-stock) 35%, transparent)' }}
            >
              <StatusRule colour="var(--c-in-stock)" />
              <div className="flex items-center gap-3.5">
                <span
                  aria-hidden="true"
                  className="grid place-items-center shrink-0 rounded-full"
                  style={{ width: 36, height: 36, background: 'var(--c-in-stock)', color: 'var(--c-on-in-stock)' }}
                >
                  <svg width="18" height="18" viewBox="0 0 12 12" fill="none">
                    <path d="M2.5 6.5L5 9L9.5 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <div className="min-w-0 leading-tight">
                  <p className="font-display font-medium tracking-[-0.01em]" style={{ color: 'var(--c-in-stock)', fontSize: 20 }}>
                    Approved
                  </p>
                  <p className="mt-0.5 text-[13px] text-ink-soft">Signed off 24 July</p>
                </div>
              </div>
              {r.status && <ApprovedOrderStatus status={r.status} />}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// A real DPD dispatch date, so the past-tense line renders the way a customer
// would actually see it rather than as a placeholder.
const SHIPPED_AT = '2026-06-24T09:15:00Z'

function mkState(
  state: 'awaiting_payment' | 'paid',
  stage: TrackingStage | null = null,
  deliveryTracked: boolean | null = null,
  shippedAt: string | null = null,
): ProofOrderStatePayload {
  return {
    state,
    expiresAt: state === 'awaiting_payment' ? '2026-08-13T12:44:59Z' : null,
    resendRequestedAt: null,
    stage,
    deliveryTracked,
    shippedAt,
    reorderAvailable: false,
    reorderRequestedAt: null,
    reorderProofId: null,
  }
}

// ?path=/reorder-panel — the customer-page "Need more?" panel (000372) in
// every state it can reach, plus the forward link (000374) that REPLACES it
// once the reorder project exists.
//
// Under the real .customer-accent scope, because this ships on /p/:id and the
// tokens resolve differently there.
//
// The thing to check is the honesty of the copy, not the layout: nothing here
// may promise a price, a date, or that an order has been placed. The customer
// is asking; a designer decides and sends the link.
function ReorderPanelRig() {
  useEffect(() => {
    document.documentElement.classList.add('customer-accent')
    return () => document.documentElement.classList.remove('customer-accent')
  }, [])
  const states: Array<{ label: string; state: ReorderState; already: boolean }> = [
    { label: 'Idle — the whole ask, two questions', state: 'idle', already: false },
    { label: 'Sending', state: 'sending', already: false },
    { label: 'Sent — acknowledges the REQUEST, never a send', state: 'sent', already: false },
    { label: 'Already asked (a reload inside the 24h window)', state: 'idle', already: true },
    { label: 'Failed — routes them somewhere that works', state: 'error', already: false },
  ]
  const forward = reorderForwardLink({
    ...mkState('paid', 'delivered', true),
    reorderRequestedAt: '2026-07-20T09:00:00Z',
    reorderProofId: 'p-a1',
  })
  return (
    // The forward panel links with <Link>, so it needs a Router in scope —
    // on /p/:id it always has one.
    <MemoryRouter initialEntries={['/p/p-a1']}>
      <div className="min-h-screen bg-canvas p-8">
      <div className="mx-auto flex max-w-[520px] flex-col gap-6">
        {states.map((s) => (
          <div key={s.label}>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-mute">
              {s.label}
            </p>
            <ReorderPanel state={s.state} alreadyRequested={s.already} onSubmit={() => {}} />
          </div>
        ))}
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-mute">
            Reorder raised — shown INSTEAD of the panel above
          </p>
          {forward && <ReorderForwardPanel link={forward} />}
        </div>

        {/* The three acknowledgements side by side. Which one shows depends on
            the note the customer typed, which lives in component state — so
            the cards above can only ever render one of them. Quoted here
            because the whole point of the split is that a customer who told us
            something changed must NOT be promised a payment link. */}
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-mute">
            The three acknowledgements
          </p>
          <div className="rounded-[14px] border border-line bg-surface p-5 text-[13px] leading-relaxed">
            {([
              ['No note — nothing changed', REORDER_COPY.sentPaymentLink],
              ['Note given — may need a fresh proof', REORDER_COPY.sentWithNote],
              ['Reload, note unknown', REORDER_COPY.sent],
            ] as const).map(([label, copy]) => (
              <div key={label} className="mb-3 last:mb-0">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-mute">{label}</p>
                <p className="mt-0.5 text-ink-soft">{copy}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
      </div>
    </MemoryRouter>
  )
}

function Elsewhere() {
  return <div style={{ padding: 40 }} data-nav-target>navigated away</div>
}

// ?path=/reorder-desk — the dashboard's Reorder desk panel (migration 000389)
// on its own, at the dashboard rail's width (~25rem), against the
// reorder-desk fixture module (verify-harness/fixtures/reorder-desk.ts,
// ids rd-…). One prospect per bucket, so Today (two served + one promoted),
// In build, the opened-but-quiet follow-up and the never-opened quiet close
// all render from a single load.
//
// The panel's settings read resolves through the shared mock's settings row,
// which carries no reorder_desk_* keys — the lib fail-safes to dailyLimit 5,
// which is deliberate: the rig proves the desk renders fixture data even when
// its settings are absent. Mounted inside a MemoryRouter because the panel
// navigates (Start → the new-project form, Open → the proof page); those
// land on Elsewhere rather than a real route.
function ReorderDeskRig() {
  return (
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          path="/"
          element={
            <div className="min-h-screen bg-canvas p-8">
              <div className="mx-auto w-full max-w-[25rem]">
                <ReorderDeskPanel />
              </div>
            </div>
          }
        />
        <Route path="*" element={<Elsewhere />} />
      </Routes>
    </MemoryRouter>
  )
}

function Stub() {
  return <div style={{ padding: 40 }} data-nav-target>stub admin page</div>
}

// ?path=/order-builder — the Create-order form, mounted on a fixture steel
// proof (EUR, three thicknesses, three finishes). Pass ?state=custom-proof to
// mount it on a proof whose VERSION is a custom quote.
//
// What to look at is the "Pricing" field, second from the top:
//   * standard proof (default) — the Catalogue price / Agreed price pills.
//     Catalogue is the default and must look exactly as it always did.
//     Clicking Agreed price reveals the agreed-total box, and everything it
//     changes is BELOW it: the Option field loses its "customer chooses"
//     pills (a fixed total can't be repriced by their pick) and the Finish
//     picker's hint drops the surcharge language.
//   * ?state=custom-proof — no pills at all, because there is no choice to
//     offer; the total box shows on its own with the proof named as the
//     reason. This is the case that used to be the ONLY way to type a total.
function OrderBuilderRig() {
  const customProof = new URLSearchParams(window.location.search).get('state') === 'custom-proof'
  return (
    <OrderBuilderModal
      proofId="p-1"
      currentVersionId="ver-p-1"
      materialId="m-steel"
      displayedVariantIds={[]}
      materialOptionCodes={['natural']}
      customerLabel="Husbyklinikkene"
      materialDisplay="Stainless Steel"
      currency="EUR"
      namesCount={0}
      hasPersonalisation={false}
      versionIsCustomQuote={customProof}
      hasHelpScoutConversation
      onClose={() => {}}
    />
  )
}

// ?path=/… is the canonical form, but some embedded preview panes strip the
// query string on navigation, so #/… is accepted as an equivalent fallback.
const requestedPath =
  new URLSearchParams(window.location.search).get('path') ||
  (window.location.hash ? window.location.hash.replace(/^#/, '') : null)

// Re-attach any non-`path` query params to the in-app path, so pages that read
// search params off the router (?token=…, ?for=…) see them inside the
// MemoryRouter. Rig components that read window.location.search directly
// (?state=…) are unaffected.
const extraQuery = (() => {
  const params = new URLSearchParams(window.location.search)
  params.delete('path')
  const qs = params.toString()
  return qs ? `?${qs}` : ''
})()

// ?path=/palette mounts the ⌘K designer command palette on its own, open, so
// its layout and the fixture-backed proof search can be checked headlessly.
const tree = requestedPath === '/order-builder' ? (
  <OrderBuilderRig />
) : requestedPath === '/reorder-panel' ? (
  <ReorderPanelRig />
) : requestedPath === '/reorder-desk' ? (
  <ReorderDeskRig />
) : requestedPath === '/approved-order-status' ? (
  <ApprovedOrderStatusRig />
) : requestedPath === '/abandon-dialog' ? (
  <AbandonDialogRig />
) : requestedPath === '/bundle-checkpoint' ? (
  <BundleCheckpointRig />
) : requestedPath === '/edit-customer-dialog' ? (
  <EditCustomerDialogRig />
) : requestedPath === '/contact-name-nudge' ? (
  <ContactNameNudgeRig />
) : requestedPath === '/detail-markers' ? (
  <DetailMarkersRig />
) : requestedPath === '/customer-pins' ? (
  <CustomerPinsRig />
) : requestedPath === '/quote-spread' ? (
  <QuoteSpreadRig />
) : requestedPath === '/recap-zoom' ? (
  <RecapZoomRig />
) : requestedPath === '/artwork-report' ? (
  <ArtworkReportRig />
) : requestedPath === '/artwork-report-cutthrough' ? (
  <ArtworkReportCutThroughRig />
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
        <Route path="analytics" element={<AdminAnalyticsPage />} />
        <Route path="settings" element={<AdminSettingsPage />} />
        <Route path="demo-data" element={<AdminDemoDataPage />} />
        <Route path="*" element={<Stub />} />
      </Route>
      <Route path="*" element={<Elsewhere />} />
    </Routes>
  </MemoryRouter>
) : requestedPath?.startsWith('/p/') ? (
  // ?path=/p/cp-… — the CUSTOMER proof page against the customer-proof fixture
  // module (verify-harness/fixtures/customer-proof.ts). Fixture ids are
  // prefixed cp-; anything unrecognised renders the page's own error state.
  <MemoryRouter initialEntries={[requestedPath + extraQuery]}>
    <Routes>
      <Route path="/p/:id" element={<CustomerProofPage />} />
      <Route path="*" element={<Elsewhere />} />
    </Routes>
  </MemoryRouter>
) : requestedPath?.startsWith('/order/group/') ? (
  // ?path=/order/group/grp-…&token=t — the combined pay page against the
  // pay-pages fixture module. Stripe's iframe never loads here; specs assert
  // everything up to the card form.
  <MemoryRouter initialEntries={[requestedPath + extraQuery]}>
    <Routes>
      <Route path="/order/group/:id" element={<OrderGroupPayPage />} />
      <Route path="*" element={<Elsewhere />} />
    </Routes>
  </MemoryRouter>
) : requestedPath?.startsWith('/order/') ? (
  // ?path=/order/pay-…&token=t — the single-order pay page against the
  // pay-pages fixture module.
  <MemoryRouter initialEntries={[requestedPath + extraQuery]}>
    <Routes>
      <Route path="/order/:id" element={<OrderPayPage />} />
      <Route path="*" element={<Elsewhere />} />
    </Routes>
  </MemoryRouter>
) : requestedPath?.startsWith('/proofs/') ? (
  // ?path=/proofs/p-a1 — the proof detail page against the approved fixture
  // project (use an id containing 'open', e.g. /proofs/p-open, for the
  // in_progress branch). Used to verify the header overflow menu (Duplicate
  // project) + its confirm dialog.
  // ?path=/proofs/vf-…/versions/new (and …/versions/:versionId/edit) — the
  // version forms against the version-form fixture module.
  <MemoryRouter initialEntries={[requestedPath]}>
    <Routes>
      <Route path="/proofs/:id/versions/new" element={<NewVersionPage />} />
      <Route path="/proofs/:id/versions/:versionId/edit" element={<EditVersionPage />} />
      <Route path="/proofs/:id" element={<ProofDetailPage />} />
      <Route path="*" element={<Elsewhere />} />
    </Routes>
  </MemoryRouter>
) : requestedPath === '/orders/log' ? (
  // ?path=/orders/log — the Order log (list + detail against the ORDERS
  // fixtures; append &order=o5 via ?path=/orders/log to deep-link isn't
  // supported here, click a row instead). MUST stay above the
  // startsWith('/orders/') branch or it falls into the place-order rig.
  <MemoryRouter initialEntries={['/orders/log']}>
    <Routes>
      <Route path="/orders/log" element={<OrderLogPage />} />
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
  // The default. extraQuery carries ?order=<id> through, so the dashboard rail's
  // Awaiting-payment deep link (which opens the collapsed Waiting section and
  // rings the card) can be exercised as ?path=/orders&order=o2.
  <MemoryRouter initialEntries={[`/orders${extraQuery}`]}>
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
