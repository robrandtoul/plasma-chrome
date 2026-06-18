import { useEffect, useState, useRef, Fragment } from 'react'
import { createPortal } from 'react-dom'
import { useParams, Link, useNavigate } from 'react-router-dom'
import JSZip from 'jszip'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import VersionDetailModal, { type ModalVersion } from '../components/VersionDetailModal'
import HelpScoutEditModal from '../components/HelpScoutEditModal'
import Modal from '../components/Modal'
import MessageSendPanel from '../components/MessageSendPanel'
import { firstName } from '../lib/firstName'
import { getRepliesEnabled } from '../lib/repliesEnabled'
import { getOrderingEnabled } from '../lib/orderingEnabled'
import OrderBuilderModal from '../components/OrderBuilderModal'
import { logAudit } from '../lib/audit'
import { relativeTime, formatAbsoluteDateTime } from '../lib/relativeTime'
import type {
  LetterpressCoreColour,
  ProofNameApproval,
  QrSnapshot,
  QrSnapshotEntry,
} from '../lib/types'
import { SHARED_APPROVAL_KEY } from '../lib/types'
import { deriveSharedApprovalState, type SharedApprovalState } from '../lib/sharedApproval'
import { useLiveProofViews } from '../lib/useLiveProofViews'
import { downloadBlob } from '../lib/downloadFile'
import { customerProofPath, openDesignerPreview } from '../lib/customerProofUrl'
// QuoteLink now lives inside DesignerChrome (PR 31).
import { DesignerChrome, ButtonCoral, ButtonGhost, ProofStatusPill, PanelShell, tokens } from '../design'
import { ChevronRight, Plus, ExternalLink, Copy, Check as CheckIcon, FileText, Pencil, Layers, MoreHorizontal, AlertTriangle, Send, Eye, MessageSquare, Clock, Activity, Package, HelpCircle } from 'lucide-react'
import {
  computeViewedState,
  viewedStateDotClass,
  viewedStateTitle,
  type ViewedState,
} from '../lib/viewedState'
import { proofBucket, isCustomerReplied, type BucketInput } from '../lib/dashboardGrouping'
import {
  sentEvidenceAt,
  buildFunnel,
  ageDays,
  totalNonBotViews,
  quantityRangeLabel,
  summaryLine,
  roundOutcome,
  type FunnelStep,
  type RespondedKind,
  type RoundOutcome,
} from '../lib/proofSnapshot'
import { ResolvePopover } from '../components/ResolvePopover'
import ProofTimeline from '../components/ProofTimeline'
import type { TimelineEventRow } from '../lib/proofTimeline'

interface Proof {
  id: string
  status: 'in_progress' | 'approved' | 'dormant' | 'abandoned'
  approved_at: string | null
  abandoned_at: string | null
  helpscout_thread_url: string | null
  helpscout_conversation_id: string | null
  helpscout_conversation_url: string | null
  helpscout_override_reason: string | null
  internal_notes: string | null
  created_at: string
  // Customer's disclaimer acknowledgement timestamp (migration
  // 000091). Null until the customer ticks the "I've read this"
  // box on the proof page. Rendered as a muted subline under the
  // status pill at any status — unlike the dashboard tail we keep
  // it visible post-approval so designers can see when the ack
  // actually happened during a dispute.
  disclaimer_acknowledged_at: string | null
  contacts: {
    full_name: string
    email: string
    companies: { name: string } | null
  }
}

function formatLongDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

// Colour + label per round outcome for the engagement panel's rounds
// strip; the RoundOutcome union + the precedence live in proofSnapshot.
// Colours mirror the dashboard status palette.
const ROUND_OUTCOME: Record<RoundOutcome, { color: string; bg: string; label: string }> = {
  approved: { color: 'var(--c-in-stock)',  bg: 'var(--c-in-stock-soft)',  label: 'approved' },
  changes:  { color: 'var(--c-low)',       bg: 'var(--c-low-soft)',       label: 'changes' },
  awaiting: { color: 'var(--c-allocated)', bg: 'var(--c-allocated-soft)', label: 'awaiting' },
  none:     { color: 'var(--c-ink-mute)',  bg: 'var(--c-line-soft)',      label: 'no reply' },
}

// One row in the Approved artwork table. Assembled from the cross-
// product of proof_name_approvals (where state='approved') and
// proof_version_images (joined on proof_version_id + associated_name,
// treating SHARED_APPROVAL_KEY as associated_name IS NULL). Each
// row is exactly one image file destined for the production ZIP.
interface ProofEventAuditDetail {
  id: string
  event_type: 'approve' | 'request_changes' | 'designer_override_approve'
  actor_name: string
  comment: string | null
  from_ip: string | null
  from_ua: string | null
  helpscout_thread_id: string | null
  created_at: string
  // Variant-round event surface (000139): the chosen direction's
  // display_name when the customer made a "Choose this direction"
  // selection. Null on standard-proof events. Resolved server-side
  // via a nested embed on proof_round_variants in the events query.
  variant_display_name: string | null
  // Phase 3 (000196): the card side the customer had open in the
  // detail view when they submitted this event. Null when no
  // detail view was open (panel opened from the overview action
  // band) or for events that predate the Phase 3 rework.
  side: 'front' | 'back' | null
}

interface ApprovedImageRow {
  imageId: string
  imagePath: string
  // Nullable on pre-migration-000021 rows. Rendered as '— (no
  // filename)' in the UI and falls back to a synthetic leaf name
  // inside the ZIP so the bundle still opens; designer can see
  // from the UI that the filename wasn't captured at upload time.
  originalFilename: string | null
  // Null side treated as 'front' per migration-000085 back-compat.
  // Stored non-null post-migration.
  side: 'front' | 'back' | null
  // Null associated_name is the Shared slot; stored as null to
  // match the DB. Rendered as 'Shared' and zipped into the Shared/
  // directory.
  associatedName: string | null
  versionNumber: number
  versionId: string
}

export default function ProofDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { role, session } = useAuth()
  const [proof, setProof] = useState<Proof | null>(null)
  // Workflow-bucket fields for this proof, read from public_dashboard_projects
  // so the status pill here matches the dashboard's pill + the headline tiles
  // (same proofBucket logic). Null until loaded / if the row can't be read —
  // the pill falls back to the raw status in that case.
  const [bucketRow, setBucketRow] = useState<BucketInput | null>(null)
  // Canonical last-activity timestamp from public_dashboard_projects —
  // the same value the dashboard buckets on. Fetched alongside bucketRow
  // (one column on the same row) to power the "Last activity" stat card
  // in the snapshot band. Null until loaded / unreadable.
  const [lastActivityAt, setLastActivityAt] = useState<string | null>(null)
  // Current version's front/back artwork (signed URLs) for the hero
  // preview at the top of the main column. One representative front +
  // one back is enough — the version modal and customer view hold the
  // full gallery. Reloaded by loadProof whenever the proof changes.
  const [heroImages, setHeroImages] = useState<{ url: string; side: 'front' | 'back' | null }[]>([])
  const [versions, setVersions] = useState<ModalVersion[]>([])
  // proof_version_id → signed thumbnail URL. Populated alongside
  // versions inside loadProof by batch-signing the first front image
  // of each version. Empty entries (no images uploaded yet) fall
  // through to the placeholder in the version card.
  const [versionThumbs, setVersionThumbs] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [selectedVersion, setSelectedVersion] = useState<ModalVersion | null>(null)
  // Real (non-bot) view times per version id for the dot indicators
  // and the VersionDetailModal history panel.
  const [viewsByVersion, setViewsByVersion] = useState<Map<string, { viewed_at: string; user_agent: string | null }[]>>(new Map())
  // All proof_name_approvals rows across every version of this
  // project, loaded alongside the main data. Drives the Names
  // roll-up section further down the page. Re-fetched by loadProof()
  // after any approval-writing action (Mark as approved shortcut,
  // modal approve/changes/clear).
  const [approvals, setApprovals] = useState<ProofNameApproval[]>([])
  // Set of version IDs that have at least one shared image
  // (proof_version_images.associated_name IS NULL). Populated
  // alongside approvals in loadProof. Drives whether the Names
  // roll-up renders its "Shared" row for the current version —
  // kept as a derived index rather than denormalised onto
  // proof_versions so the truth stays in the images table.
  const [versionsWithShared, setVersionsWithShared] = useState<Set<string>>(new Set())
  // Letterpress layer-colour catalogue (migrations 000133 + 000135).
  // Fetched once on mount and passed into VersionDetailModal so the
  // docket can render Front / Core / Back rows for letterpress
  // versions. Empty array on the more common non-letterpress paths;
  // the modal's docket rows quietly drop out when the catalogue is
  // empty or a colour id doesn't resolve. RLS already filters to
  // is_active=true for the authenticated designer role, so inactive
  // colours don't appear; legacy versions that referenced a now-
  // inactive colour just won't render that layer's row.
  const [coreColours, setCoreColours] = useState<LetterpressCoreColour[]>([])
  // Phase 2 Prompt 8 — proof_events audit detail for the Names
  // rollup. Loaded alongside approvals so each rollup row can
  // expand into the customer's own action detail (actor, comment,
  // timestamp, IP/UA, HS thread). Map keyed by `${versionId}|${name}`,
  // value is the chronologically-latest event for that pair.
  const [eventsByVersionAndName, setEventsByVersionAndName] = useState<
    Map<string, ProofEventAuditDetail>
  >(new Map())
  // Every proof_events row for this project, unreduced — feeds the
  // Activity timeline panel. Populated from the same fetch as the
  // eventsByVersionAndName reduction above (no extra round-trip).
  const [timelineEvents, setTimelineEvents] = useState<TimelineEventRow[]>([])
  // auth user id → designer full name, for the timeline's "Donna
  // created v2" / "Donna sent a reply for v2" attribution. Resolved
  // from profiles (open authenticated SELECT) because audit_log —
  // the other place these names live — is admin-only by RLS.
  const [designerNames, setDesignerNames] = useState<Map<string, string>>(new Map())
  // Tracks which Names rollup row is expanded into the audit panel.
  // Single-string key ensures only one panel is open at a time.
  const [expandedAuditKey, setExpandedAuditKey] = useState<string | null>(null)
  // Toggles the "what does this show?" explainer inside the engagement
  // panel — collapsed by default so it stays clean once a designer knows
  // the panel, expandable for anyone seeing it for the first time.
  const [funnelHelpOpen, setFunnelHelpOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [statusDialog, setStatusDialog] = useState<'approve' | 'reopen' | 'abandon' | 'delete' | null>(null)
  const [statusWorking, setStatusWorking] = useState(false)
  // Synchronous guard against double-click on the confirm dialog
  // buttons. The disabled={working} prop is bound to React state,
  // so a second click that lands before the state commits would
  // otherwise fire the destructive handler twice. The ref flips
  // immediately on entry and is cleared on every exit path.
  const statusActionInFlightRef = useRef(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [showHelpscoutEdit, setShowHelpscoutEdit] = useState(false)
  // Internal-notes inline edit state. notesEditing flips the panel
  // into textarea mode; notesDraft holds the editing buffer so Cancel
  // can revert without touching proof.internal_notes; notesSaving
  // gates the Save button to prevent double-submits.
  const [notesEditing, setNotesEditing] = useState(false)
  const [notesDraft, setNotesDraft]     = useState('')
  const [notesSaving, setNotesSaving]   = useState(false)
  // Customer reply re-send modal + confirm-on-resend state. Both
  // local-only — no URL or persisted state. The confirm-then-open
  // sequence runs entirely client-side; opening the modal commits
  // the editor flow which has its own audit log + send pipeline.
  const [showReplyModal, setShowReplyModal] = useState(false)
  const [showResendConfirm, setShowResendConfirm] = useState(false)
  // Global on/off flag for the customer-reply send (migration
  // 000104). Loaded on mount via the cached fetch in
  // repliesEnabled.ts; null while loading. When false, the
  // Customer reply section disables the Send / Send again buttons
  // and adds an explanatory subtitle. The edge function rejects
  // independently so this is the courtesy layer.
  const [repliesEnabled, setRepliesEnabled] = useState<boolean | null>(null)
  // Ordering & checkout master switch (migration 000228). Gates the
  // "Create order" button on approved proofs; defaults closed until
  // the cached fetch resolves so the button never flashes when off.
  const [orderingEnabled, setOrderingEnabled] = useState<boolean | null>(null)
  const [showOrderBuilder, setShowOrderBuilder] = useState(false)
  // Approved artwork table data. Null = not loaded yet (project may
  // not be approved, or the fetch hasn't run); [] = approved but no
  // matching images (approval row with every slot's images deleted
  // since — theoretically possible, UI shows an empty-state line).
  const [approvedImages, setApprovedImages] = useState<ApprovedImageRow[] | null>(null)
  // Download-button state machine. 'idle' → 'preparing' during
  // fetch+zip; any fetch failure flips to 'idle' and surfaces the
  // toast via showToast (no partial ZIP ever ships).
  const [zipPreparing, setZipPreparing] = useState(false)
  const fallbackInputRef = useRef<HTMLInputElement>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Monotonic id for loadProof. Status changes (approve / reopen /
  // abandon) and modal-driven mutations all fire-and-forget loadProof
  // afterwards. Without a guard, a rapid second action — or a
  // double-click — can interleave two concurrent loads and the later
  // setState calls win arbitrarily, leaving approvals / events /
  // approved-images out of sync. Bumping the id at the start and
  // checking it before each setState keeps only the newest load's
  // results.
  const loadIdRef = useRef(0)

  useEffect(() => {
    if (id) loadProof(id)
  }, [id])

  // Mount-time fetch of the global replies-enabled flag. Cached
  // via repliesEnabled.ts so concurrent surfaces share the same
  // value; mount cost is one DB read per 60s of session.
  useEffect(() => {
    let cancelled = false
    void getRepliesEnabled().then((v) => {
      if (!cancelled) setRepliesEnabled(v)
    })
    return () => { cancelled = true }
  }, [])

  // Mount-time fetch of the ordering master switch. Same cached,
  // fail-safe-false pattern as repliesEnabled above.
  useEffect(() => {
    let cancelled = false
    void getOrderingEnabled().then((v) => {
      if (!cancelled) setOrderingEnabled(v)
    })
    return () => { cancelled = true }
  }, [])

  // Letterpress core-colour catalogue (migrations 000133 + 000135).
  // Fetched once on mount and passed into VersionDetailModal. RLS
  // filters to is_active=true for designers, so the array reflects
  // the currently-available palette. Non-letterpress proofs never
  // consult this, but the fetch is cheap (~8 rows) and avoids the
  // gate-and-conditional-fetch complexity of probing the loaded
  // versions list first.
  useEffect(() => {
    let cancelled = false
    void supabase
      .from('letterpress_core_colours')
      .select('id, name, hex_value, is_active, sort_order')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })
      .then(({ data }) => {
        if (!cancelled) setCoreColours((data ?? []) as LetterpressCoreColour[])
      })
    return () => { cancelled = true }
  }, [])

  // Live realtime subscription — appends non-bot view rows to
  // viewsByVersion as they arrive, so the customer-viewed dot
  // updates without a refresh. Runs alongside the load-time
  // fetch inside loadProof; the two don't conflict because the
  // fetch overwrites the whole Map on reload and the hook
  // appends incremental rows in between. Bot filter matches the
  // fetch's .eq('is_bot', false) condition so live and refresh
  // paths surface the same set of rows.
  useLiveProofViews({
    proofId: id,
    versionIds: versions.map((v) => v.id),
    onView: (row) => {
      setViewsByVersion((prev) => {
        // Idempotent append: if the row's id is already in the
        // list (rare, but possible if the fetch races with the
        // subscription and picks up the same row), skip. Newest
        // rows go to the front to match the load-time query's
        // .order('viewed_at', { ascending: false }).
        const existing = prev.get(row.proof_version_id) ?? []
        if (existing.some((r) => r.viewed_at === row.viewed_at && r.user_agent === row.user_agent)) {
          return prev
        }
        const next = new Map(prev)
        next.set(row.proof_version_id, [
          { viewed_at: row.viewed_at, user_agent: row.user_agent },
          ...existing,
        ])
        return next
      })
    },
  })

  // Per-version thumbnail fetch + sign. Same shape as the
  // dashboard's loadThumbnails (PR 26) — one .in() query for first
  // front image per version_id, one createSignedUrls round-trip.
  // Returns a Map keyed on version id so the version card can look
  // up its thumb by id.
  async function loadVersionThumbnails(rows: ModalVersion[]): Promise<Map<string, string>> {
    const versionIds = rows.map((v) => v.id)
    if (versionIds.length === 0) return new Map()

    const { data: imageRows, error } = await supabase
      .from('proof_version_images')
      .select('proof_version_id, image_path, sort_order, side')
      .in('proof_version_id', versionIds)
      .eq('is_qr_code', false)
      .order('sort_order', { ascending: true })
    if (error || !imageRows) return new Map()

    const pathByVersion = new Map<string, string>()
    for (const r of imageRows as Array<{ proof_version_id: string; image_path: string; side: string | null }>) {
      if (pathByVersion.has(r.proof_version_id)) continue
      if (r.side === 'back') continue
      pathByVersion.set(r.proof_version_id, r.image_path)
    }
    // Fill versions that only have back-side images.
    for (const r of imageRows as Array<{ proof_version_id: string; image_path: string }>) {
      if (!pathByVersion.has(r.proof_version_id)) {
        pathByVersion.set(r.proof_version_id, r.image_path)
      }
    }
    if (pathByVersion.size === 0) return new Map()

    const paths = Array.from(pathByVersion.values())
    const { data: signedData } = await supabase.storage
      .from('proof-images')
      .createSignedUrls(paths, 3600)
    if (!signedData) return new Map()

    const urlByPath = new Map<string, string>()
    for (const r of signedData) {
      if (r.path && r.signedUrl) urlByPath.set(r.path, r.signedUrl)
    }
    const urlByVersion = new Map<string, string>()
    for (const [versionId, path] of pathByVersion) {
      const url = urlByPath.get(path)
      if (url) urlByVersion.set(versionId, url)
    }
    return urlByVersion
  }

  async function loadProof(proofId: string) {
    const myLoadId = ++loadIdRef.current
    const isStale = () => myLoadId !== loadIdRef.current

    const [proofResult, versionsResult] = await Promise.all([
      supabase
        .from('proofs')
        .select('id, status, approved_at, abandoned_at, helpscout_thread_url, helpscout_conversation_id, helpscout_conversation_url, helpscout_override_reason, internal_notes, created_at, disclaimer_acknowledged_at, contacts(full_name, email, companies(name))')
        .eq('id', proofId)
        .single(),
      supabase
        .from('proof_versions')
        .select('id, version_number, material_id, material_display, ink_names, currency, is_current, created_at, created_by, change_notes, pricing_snapshot, shipping_note, custom_quote, names, card_type, last_reply_sent_at, last_reply_sent_by, displayed_variant_ids, is_variant_round, is_per_direction_pricing, material_options, has_personalisation, front_colour_id, core_colour_id, back_colour_id, materials(display_quantities)')
        .eq('proof_id', proofId)
        .order('version_number', { ascending: false }),
    ])

    if (isStale()) return

    if (proofResult.error || !proofResult.data) {
      navigate('/')
      return
    }

    const loadedVersions = (versionsResult.data ?? []) as unknown as ModalVersion[]
    setProof(proofResult.data as unknown as Proof)
    setVersions(loadedVersions)
    setLoading(false)

    // Pull this proof's workflow-bucket fields from public_dashboard_projects
    // so the status pill reads identically to the dashboard (proofBucket).
    // Non-blocking + best-effort: a failure just leaves the pill on the raw
    // status fallback rather than breaking the page load.
    void supabase
      .from('public_dashboard_projects')
      .select('status, current_version_id, current_version_viewed_at, latest_non_view_event_type, latest_non_view_event_at, version_created_at, rule_code, rule_meta, snoozed_until, helpscout_last_reply_at, helpscout_last_customer_reply_at, last_activity_at')
      .eq('proof_id', proofId)
      .maybeSingle()
      .then(({ data }) => {
        if (isStale() || !data) return
        setBucketRow(data as unknown as BucketInput)
        setLastActivityAt((data as { last_activity_at: string | null }).last_activity_at ?? null)
      })

    // Per-version thumbnails. Same pattern as the dashboard
    // (loadThumbnails in PR 26): collect every version id, fetch
    // first front image per version in one .in() query, batch-sign
    // through Supabase Storage in one round-trip. Errors are
    // tolerated silently — missing thumbs fall through to the
    // placeholder in the version card. Doesn't await — the
    // versions panel renders immediately and thumbs swap in.
    void loadVersionThumbnails(loadedVersions).then((m) => {
      if (isStale()) return
      setVersionThumbs(m)
    })

    // Hero images — the current version's first front + first back,
    // signed. Same storage path + createSignedUrls pattern as the
    // thumbnails, but scoped to the current version and keeping the
    // back side so the hero can show both faces. Best-effort: any
    // failure leaves the hero on its "no artwork yet" placeholder.
    const currentForHero = loadedVersions.find((v) => v.is_current)
    if (currentForHero) {
      void (async () => {
        const { data: imgRows } = await supabase
          .from('proof_version_images')
          .select('image_path, side, sort_order')
          .eq('proof_version_id', currentForHero.id)
          .eq('is_qr_code', false)
          .order('sort_order', { ascending: true })
        if (isStale()) return
        const rows = (imgRows ?? []) as Array<{ image_path: string; side: 'front' | 'back' | null }>
        const front = rows.find((r) => r.side !== 'back')
        const back = rows.find((r) => r.side === 'back')
        const picked = [front, back].filter(
          (r): r is { image_path: string; side: 'front' | 'back' | null } => !!r,
        )
        if (picked.length === 0) {
          setHeroImages([])
          return
        }
        const { data: signed } = await supabase.storage
          .from('proof-images')
          .createSignedUrls(
            picked.map((r) => r.image_path),
            3600,
          )
        if (isStale() || !signed) return
        const urlByPath = new Map<string, string>()
        for (const s of signed) if (s.path && s.signedUrl) urlByPath.set(s.path, s.signedUrl)
        setHeroImages(
          picked
            .map((r) => ({ url: urlByPath.get(r.image_path) ?? '', side: r.side }))
            .filter((x) => x.url),
        )
      })()
    } else {
      setHeroImages([])
    }

    // Resolve designer names for the timeline's attribution lines.
    // One small .in() lookup on profiles covering both created_by and
    // last_reply_sent_by across every version. Non-blocking and
    // best-effort — a failure just leaves entries on the
    // unattributed milestone copy ("v2 created").
    const designerIds = Array.from(
      new Set(
        loadedVersions
          .flatMap((v) => [v.created_by, v.last_reply_sent_by])
          .filter((id): id is string => id != null),
      ),
    )
    if (designerIds.length > 0) {
      void supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', designerIds)
        .then(({ data }) => {
          if (isStale() || !data) return
          const map = new Map<string, string>()
          for (const r of data as Array<{ id: string; full_name: string | null }>) {
            if (r.full_name) map.set(r.id, r.full_name)
          }
          setDesignerNames(map)
        })
    } else {
      setDesignerNames(new Map())
    }

    // Pull non-bot view rows for every version on this proof. Same
    // query shape as the dashboard's map; kept separate so reload
    // flows (e.g. after a status change) refresh view data too.
    const versionIds = loadedVersions.map((v) => v.id)
    if (versionIds.length > 0) {
      const { data: viewRows } = await supabase
        .from('proof_version_views')
        .select('proof_version_id, viewed_at, user_agent')
        .eq('is_bot', false)
        .in('proof_version_id', versionIds)
        .order('viewed_at', { ascending: false })
      if (isStale()) return
      const map = new Map<string, { viewed_at: string; user_agent: string | null }[]>()
      for (const r of (viewRows ?? []) as any[]) {
        const list = map.get(r.proof_version_id) ?? []
        list.push({ viewed_at: r.viewed_at, user_agent: r.user_agent })
        map.set(r.proof_version_id, list)
      }
      setViewsByVersion(map)
    } else {
      setViewsByVersion(new Map())
    }

    // Pull every approval row for this project's versions in one
    // round-trip. Client-side reduction (latest row per name across
    // all versions) happens at render time from the flat array — the
    // data volume is small (one row per recipient per version, which
    // for a typical split-name project is single digits).
    let approvalRowsLoaded: ProofNameApproval[] = []
    if (versionIds.length > 0) {
      const { data: approvalRows } = await supabase
        .from('proof_name_approvals')
        .select('*')
        .in('proof_version_id', versionIds)
      if (isStale()) return
      approvalRowsLoaded = (approvalRows ?? []) as ProofNameApproval[]
      setApprovals(approvalRowsLoaded)
    } else {
      setApprovals([])
    }

    // Phase 2 Prompt 8 — proof_events audit detail for the Names
    // rollup expansion panel. Reduces the flat per-event rows to
    // "latest event per (version, name)" client-side; the volume is
    // tiny (≤ recipients × versions). Designers see all events
    // (proof_events RLS is authenticated read).
    if (versionIds.length > 0) {
      // Nested embed on proof_round_variants resolves the chosen
      // direction's display_name (000139) for variant-round events
      // without a second round-trip. Returns null on standard-
      // proof events (round_variant_id is null) — no extra rows are
      // added by the LEFT JOIN.
      const { data: eventRows } = await supabase
        .from('proof_events')
        .select('id, proof_version_id, name, event_type, actor_name, comment, from_ip, from_ua, helpscout_thread_id, created_at, round_variant_id, side, proof_round_variants(display_name)')
        .in('proof_version_id', versionIds)
        .order('created_at', { ascending: false })
      if (isStale()) return
      const map = new Map<string, ProofEventAuditDetail>()
      // Supabase-js types the nested embed as either an object or an
      // array depending on the FK shape; the runtime shape for a to-
      // one FK like proof_events.round_variant_id is a single object
      // (or null when the FK is null). The cast here unwraps both
      // possibilities and pulls the display_name off whichever shape
      // came back.
      type RawEventRow = {
        id: string
        proof_version_id: string
        name: string | null
        event_type: ProofEventAuditDetail['event_type']
        actor_name: string
        comment: string | null
        from_ip: string | null
        from_ua: string | null
        helpscout_thread_id: string | null
        created_at: string
        round_variant_id: string | null
        side: 'front' | 'back' | null
        proof_round_variants:
          | { display_name: string }
          | { display_name: string }[]
          | null
      }
      const flatRows: TimelineEventRow[] = []
      for (const r of (eventRows ?? []) as unknown as RawEventRow[]) {
        const embed = r.proof_round_variants
        const variantDisplayName = Array.isArray(embed)
          ? (embed[0]?.display_name ?? null)
          : (embed?.display_name ?? null)
        flatRows.push({
          id: r.id,
          proof_version_id: r.proof_version_id,
          event_type: r.event_type,
          actor_name: r.actor_name,
          name: r.name,
          comment: r.comment,
          helpscout_thread_id: r.helpscout_thread_id,
          created_at: r.created_at,
          variant_display_name: variantDisplayName,
        })
        const k = `${r.proof_version_id}|${r.name ?? SHARED_APPROVAL_KEY}`
        if (!map.has(k)) {
          map.set(k, {
            id: r.id,
            event_type: r.event_type,
            actor_name: r.actor_name,
            comment: r.comment,
            from_ip: r.from_ip,
            from_ua: r.from_ua,
            helpscout_thread_id: r.helpscout_thread_id,
            created_at: r.created_at,
            variant_display_name: variantDisplayName,
            side: r.side,
          })
        }
      }
      setEventsByVersionAndName(map)
      setTimelineEvents(flatRows)
    } else {
      setEventsByVersionAndName(new Map())
      setTimelineEvents([])
    }

    // Approved-artwork join. Only bothers with the fetch when the
    // project's roll-up status is 'approved' — same gate as the
    // "Approved on …" header badge. The table + ZIP section above
    // Delete renders only in that case, so loading it eagerly for
    // every project would waste a round-trip.
    //
    // Shape of the join: for each approval row with state='approved',
    // pick proof_version_images rows matching (proof_version_id,
    // associated_name), treating SHARED_APPROVAL_KEY as
    // associated_name IS NULL. Cross-version splits (Alice approved
    // in v2, Bob in v3) fall out for free — we scope the image
    // query to all of the project's version IDs and filter client-
    // side by the approval tuples.
    if (proofResult.data.status === 'approved' && versionIds.length > 0) {
      const approvedApprovals = approvalRowsLoaded.filter(
        (a) => a.state === 'approved',
      )
      if (approvedApprovals.length === 0) {
        // Approved status with no per-name approvals shouldn't
        // happen under the current approve-shortcut flow (it
        // always writes approvals first), but if it ever did
        // (legacy data, direct DB edit), show an empty table
        // rather than crash.
        setApprovedImages([])
      } else {
        const { data: imageRows } = await supabase
          .from('proof_version_images')
          .select('id, image_path, original_filename, associated_name, side, proof_version_id')
          .in('proof_version_id', versionIds)
          .eq('is_qr_code', false)
        if (isStale()) return

        const approvalTuples = new Set(
          approvedApprovals.map(
            (a) =>
              `${a.proof_version_id}|${a.name === SHARED_APPROVAL_KEY ? '__null__' : a.name}`,
          ),
        )
        const versionNumberById = new Map<string, number>()
        for (const v of loadedVersions) versionNumberById.set(v.id, v.version_number)

        // Dedupe by image id as a belt-and-braces guard — a shared
        // image shouldn't appear under two approvals (Shared has
        // its own approval row), but defensive dedupe costs
        // nothing.
        const seen = new Set<string>()
        const rows: ApprovedImageRow[] = []
        for (const r of (imageRows ?? []) as {
          id: string
          image_path: string
          original_filename: string | null
          associated_name: string | null
          side: 'front' | 'back' | null
          proof_version_id: string
        }[]) {
          const key = `${r.proof_version_id}|${r.associated_name ?? '__null__'}`
          if (!approvalTuples.has(key)) continue
          if (seen.has(r.id)) continue
          seen.add(r.id)
          rows.push({
            imageId: r.id,
            imagePath: r.image_path,
            originalFilename: r.original_filename,
            side: r.side,
            associatedName: r.associated_name,
            versionId: r.proof_version_id,
            versionNumber: versionNumberById.get(r.proof_version_id) ?? 0,
          })
        }
        setApprovedImages(rows)
      }
    } else {
      setApprovedImages(null)
    }

    // Mark which versions have at least one shared image (rows with
    // associated_name IS NULL). One cheap select of just the
    // version IDs — client-side dedupes into a Set for O(1) lookup
    // when the Names roll-up asks whether to render its Shared row.
    if (versionIds.length > 0) {
      const { data: sharedRows } = await supabase
        .from('proof_version_images')
        .select('proof_version_id')
        .in('proof_version_id', versionIds)
        .is('associated_name', null)
        .eq('is_qr_code', false)
      if (isStale()) return
      const set = new Set<string>()
      for (const r of (sharedRows ?? []) as { proof_version_id: string }[]) {
        set.add(r.proof_version_id)
      }
      setVersionsWithShared(set)
    } else {
      setVersionsWithShared(new Set())
    }
  }

  function showToast(message: string) {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast(message)
    toastTimerRef.current = setTimeout(() => setToast(null), 3000)
  }

  function handleVersionUpdated(message: string) {
    setSelectedVersion(null)
    showToast(message)
    if (id) loadProof(id)
  }

  // Wrapper that guards every status action against double-click.
  // The disabled={statusWorking} prop on the confirm button is
  // bound to React state, so a second click that lands before the
  // state commit would otherwise fire the handler twice and create
  // duplicate audit rows / stale toasts. The ref check is purely
  // synchronous and clears in finally so a handler that throws
  // doesn't permanently lock the dialog.
  function guardStatusAction(fn: () => Promise<void>): () => Promise<void> {
    return async () => {
      if (statusActionInFlightRef.current) return
      statusActionInFlightRef.current = true
      try { await fn() } finally { statusActionInFlightRef.current = false }
    }
  }

  async function handleApprove() {
    if (!proof) return

    // Designer identity is required for both the override audit
    // (overridden_by_user_id) and actor_name attribution. Fail fast
    // if the session has expired between page load and click —
    // writing a placeholder string would silently corrupt the audit
    // trail. handleApprove is gated behind a designer-only route,
    // so this is a recovery path, not a happy path.
    if (!session?.user.id || !session.user.email) {
      showToast('Session expired — please sign in again before approving')
      setStatusDialog(null)
      return
    }
    const designerName = session.user.email
    const designerUserId = session.user.id

    setStatusWorking(true)

    // Step 1: per-name approval rows on the current version. Each
    // expected slot key falls into one of three branches:
    //
    //   • already approved   — no-op (skipped, keeps updated_at stable)
    //   • no existing row    — fresh designer-side approval; insert a
    //                          row stamped with the designer's email
    //                          as actor_name (the customer never
    //                          acted on this slot, so attributing to
    //                          the customer would be misleading)
    //   • changes_requested  — OVERRIDE. Flip state to 'approved'
    //                          via a targeted UPDATE that deliberately
    //                          does NOT touch actor_name or
    //                          change_request, preserving the
    //                          customer's original feedback so the
    //                          names rollup can render
    //                          "(originally requested changes by …)".
    //                          Stamps the three override columns
    //                          (000129) and emits a proof_events row
    //                          with event_type='designer_override_
    //                          approve' so the dashboard activity
    //                          feed records the override.
    //
    // Pre-fetch reads from the DB rather than the in-memory `approvals`
    // state so a customer action between page load and click is seen.
    // Shared-presence is checked the same way for the same reason.
    const currentVersion = versions.find((v) => v.is_current)
    if (currentVersion) {
      const { data: sharedRows } = await supabase
        .from('proof_version_images')
        .select('id')
        .eq('proof_version_id', currentVersion.id)
        .is('associated_name', null)
        .eq('is_qr_code', false)
        .limit(1)
      const hasShared = (sharedRows?.length ?? 0) > 0

      const keys: string[] = [...currentVersion.names]
      if (hasShared) keys.push(SHARED_APPROVAL_KEY)

      if (keys.length > 0) {
        const { data: existingRows, error: existingErr } = await supabase
          .from('proof_name_approvals')
          .select('id, name, state, actor_name, change_request')
          .eq('proof_version_id', currentVersion.id)
          .in('name', keys)
        if (existingErr) {
          setStatusWorking(false)
          setStatusDialog(null)
          showToast(`Failed to load existing approvals: ${existingErr.message}`)
          return
        }
        type ExistingRow = {
          id: string
          name: string
          state: 'approved' | 'changes_requested'
          actor_name: string
          change_request: string | null
        }
        const existingByName = new Map<string, ExistingRow>()
        for (const r of (existingRows ?? []) as ExistingRow[]) {
          existingByName.set(r.name, r)
        }

        const now = new Date().toISOString()

        // Build override + fresh-insert lists. Already-approved
        // slots are silently skipped.
        const overrides: ExistingRow[] = []
        const freshInserts: Array<{
          proof_version_id: string
          name: string
          state: 'approved'
          change_request: null
          actor_name: string
          actor_ip: null
          actor_ua: null
          updated_at: string
          qr_confirmed_at: string
        }> = []
        for (const key of keys) {
          const existing = existingByName.get(key)
          if (!existing) {
            freshInserts.push({
              proof_version_id: currentVersion.id,
              name: key,
              state: 'approved',
              change_request: null,
              actor_name: designerName,
              actor_ip: null,
              actor_ua: null,
              updated_at: now,
              // Migration 000169 — designer override stamps
              // qr_confirmed_at=now() per the migration comment
              // ("the designer-override path (Mark as approved)
              // writing qr_confirmed_at = now() are handled in
              // their respective TSX files"). Without this, the
              // approval row lands in an inconsistent state
              // (state='approved' AND version has QRs AND
              // qr_confirmed_at IS NULL) that the DB predicate
              // refuses to count, byte-identity carry-forward then
              // propagates the null into v(N+1), and any future
              // re-finalize after reopen disagrees with the
              // explicit status='approved' write below.
              qr_confirmed_at: now,
            })
          } else if (existing.state === 'changes_requested') {
            overrides.push(existing)
          }
          // else: existing.state === 'approved' → no-op
        }

        // Write order (PR #7 — re-ordered from PR #6):
        //
        //   1. proof_events override rows via the
        //      log_designer_override_event RPC (000130). Hard-fail
        //      on first error — nothing has changed in the DB yet,
        //      so an early abort leaves no inconsistent state.
        //   2. proof_name_approvals override UPDATEs.
        //   3. proof_name_approvals fresh INSERTs.
        //
        // Pre-PR-#7 the events insert ran last and was tolerant of
        // failure (toast, continue). That partial-success path masked
        // the PR-#6 RLS regression — proof_events RLS rejected the
        // designer-side insert silently, the override row landed
        // anyway, the toast was clobbered by the success toast within
        // milliseconds, and the activity feed lost the slate row.
        // Writing events FIRST through the SECURITY DEFINER RPC
        // closes that window: actor_name is stamped from
        // auth.users.email server-side (non-spoofable), RLS isn't
        // in the picture, and any failure aborts before any state
        // change.
        if (overrides.length > 0) {
          for (const o of overrides) {
            const { error: rpcErr } = await supabase.rpc(
              'log_designer_override_event',
              {
                p_proof_version_id: currentVersion.id,
                p_name: o.name,
              },
            )
            if (rpcErr) {
              setStatusWorking(false)
              setStatusDialog(null)
              showToast(
                `Couldn't record the override audit entry for ${o.name}: ${rpcErr.message}. The project has not been marked as approved. Please retry or contact support.`,
              )
              return
            }
          }
        }

        // Apply override updates one row at a time. Volume is small
        // (one row per recipient with an open change-request) and
        // Supabase REST doesn't expose a multi-row update with
        // distinct values, so .update().eq('id', …) per row is the
        // cleanest path. Failing fast on the first error mirrors
        // the existing "any DB error aborts the flow" pattern.
        // Caveat: events have already been inserted at this point
        // — a failure here leaves orphan event rows. The likelihood
        // is small (no RLS gate on this table for authenticated
        // role) and the rollup remains coherent (override row not
        // updated → still reads as changes_requested, with the
        // event ignored by the customer-page state-aware filter).
        for (const row of overrides) {
          const { error: upErr } = await supabase
            .from('proof_name_approvals')
            .update({
              state: 'approved',
              overridden_from_state: 'changes_requested',
              overridden_by_user_id: designerUserId,
              overridden_at: now,
              updated_at: now,
              // Migration 000169 — see freshInserts comment above.
              // The customer originally requested changes (no
              // qr_confirmed_at on the changes_requested row), so
              // stamping the designer's override timestamp here
              // closes the same predicate gap the fresh-insert path
              // closes. Preserves the row's original actor_name and
              // change_request so the names rollup keeps reading
              // "(originally requested changes by …)".
              qr_confirmed_at: now,
              // Deliberately NOT touching actor_name or change_request —
              // those preserve the customer's original feedback so
              // the names rollup can show
              // "(originally requested changes by …: …)".
            })
            .eq('id', row.id)
          if (upErr) {
            setStatusWorking(false)
            setStatusDialog(null)
            showToast(`Failed to record override: ${upErr.message}`)
            return
          }
        }

        // Fresh inserts in one round-trip.
        if (freshInserts.length > 0) {
          const { error: insErr } = await supabase
            .from('proof_name_approvals')
            .insert(freshInserts)
          if (insErr) {
            setStatusWorking(false)
            setStatusDialog(null)
            showToast(`Failed to record per-name approvals: ${insErr.message}`)
            return
          }
        }
      }
    }

    // Step 2: flip project status to approved and stamp approved_at.
    // Kept identical to the pre-per-name-approval behaviour so
    // nothing downstream (status pill, customer page banner, etc.)
    // has to change. The 000126 trigger may have already done this
    // pass when the override UPDATE landed; the explicit update is
    // an idempotent second pass.
    const { error } = await supabase
      .from('proofs')
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .eq('id', proof.id)
    setStatusWorking(false)
    setStatusDialog(null)
    if (!error) {
      void logAudit({
        action: 'proof.approved',
        targetType: 'proof',
        targetId: proof.id,
        targetLabel: proof.contacts.full_name,
        beforeValue: { status: proof.status },
        afterValue: { status: 'approved' },
      })
      showToast('Project marked as approved')
      if (id) loadProof(id)
    }
  }

  async function handleReopen() {
    if (!proof) return
    setStatusWorking(true)
    // Atomic status flip + clear of every per-recipient approval row
    // across every version of this proof. The DELETE is critical:
    // without it, v1's approved rows survive the reopen and the
    // carry-forward block in NewVersionPage picks them up when a
    // designer adds v2, leaving the customer page treating v2 as
    // pre-approved (no Approve / Request changes buttons). See
    // 000158 migration header for the full rationale.
    //
    // RPC returns the count of cleared approvals. Surfaces in the
    // audit row as a structured signal of what reopen actually did.
    const { data, error } = await supabase.rpc('reopen_proof', {
      p_proof_id: proof.id,
    })
    setStatusWorking(false)
    setStatusDialog(null)
    if (error) {
      // Surface the failure to the designer rather than silently
      // returning to the proof view: the previous "if (!error)" with
      // no else made a failed reopen look identical to a successful
      // one (no toast, status unchanged), which on its own is a
      // confusing UX and on top of that meant the audit log carried
      // no signal of the attempt at all. With this branch we still
      // skip the audit row on failure (no state actually changed),
      // but the designer sees what went wrong and can retry.
      showToast(`Could not reopen project: ${error.message}`)
      return
    }
    const approvalsCleared = typeof data === 'number' ? data : 0
    void logAudit({
      action: 'proof.reopened',
      targetType: 'proof',
      targetId: proof.id,
      targetLabel: proof.contacts.full_name,
      beforeValue: { status: proof.status },
      afterValue: {
        status: 'in_progress',
        approvals_cleared: approvalsCleared,
      },
    })
    showToast('Project reopened')
    if (id) loadProof(id)
  }

  async function handleDelete() {
    if (!proof) return
    setStatusWorking(true)
    setDeleteError(null)

    // Gather every storage path linked to any version of this proof so we
    // can clean those files up after the DB cascade fires.
    const versionIds = versions.map((v) => v.id)
    let imagePaths: string[] = []
    if (versionIds.length > 0) {
      const { data: images } = await supabase
        .from('proof_version_images')
        .select('image_path')
        .in('proof_version_id', versionIds)
      imagePaths = (images ?? []).map((r: any) => r.image_path)
    }

    const { error } = await supabase.rpc('delete_proof_cascade', { p_proof_id: proof.id })
    if (error) {
      setDeleteError(error.message)
      setStatusWorking(false)
      return
    }

    // Best-effort storage cleanup — the DB record is already gone, so a
    // storage miss just leaves orphan files (not a correctness issue).
    if (imagePaths.length > 0) {
      await supabase.storage.from('proof-images').remove(imagePaths)
    }

    void logAudit({
      action: 'proof.deleted',
      targetType: 'proof',
      targetId: proof.id,
      targetLabel: proof.contacts.full_name,
      metadata: { versions_deleted: versions.length, storage_paths_removed: imagePaths.length },
    })

    setStatusWorking(false)
    setStatusDialog(null)
    navigate('/')
  }

  async function handleAbandon() {
    if (!proof) return
    setStatusWorking(true)
    const { error } = await supabase
      .from('proofs')
      .update({ status: 'abandoned', abandoned_at: new Date().toISOString() })
      .eq('id', proof.id)
    setStatusWorking(false)
    setStatusDialog(null)
    if (!error) {
      void logAudit({
        action: 'proof.abandoned',
        targetType: 'proof',
        targetId: proof.id,
        targetLabel: proof.contacts.full_name,
        beforeValue: { status: proof.status },
        afterValue: { status: 'abandoned' },
      })
      showToast('Project abandoned')
      if (id) loadProof(id)
    }
  }

  // Fetch every approved image, assemble a ZIP with a manifest, and
  // trigger a download. Intended for production handoff — filenames
  // in the ZIP match the source Illustrator files by name, so
  // originalFilename is used verbatim as the leaf and never
  // rewritten. Front/back distinction lives only in the manifest.
  //
  // Concurrency cap: 4 parallel signed-URL fetches. Smaller ZIPs
  // finish quickly; large multi-recipient projects don't thrash
  // the connection. Any fetch failure aborts the whole operation
  // — a partial ZIP to production would be worse than a retry.
  async function handleDownloadZip() {
    if (!proof || !approvedImages || approvedImages.length === 0) return
    if (zipPreparing) return
    setZipPreparing(true)

    const projectName = proof.contacts.full_name
    const customerName = proof.contacts.companies?.name ?? '—'

    // Fetch helper: signed URL → blob. Short expiry matches the
    // rest of the app; the ZIP build finishes well inside the 60s
    // window.
    const fetchBlob = async (imagePath: string): Promise<Blob> => {
      const { data: signed, error } = await supabase.storage
        .from('proof-images')
        .createSignedUrl(imagePath, 60)
      if (error || !signed?.signedUrl) {
        throw new Error(`Couldn't sign URL for ${imagePath}: ${error?.message ?? 'no URL'}`)
      }
      const resp = await fetch(signed.signedUrl)
      if (!resp.ok) {
        throw new Error(`Download failed for ${imagePath}: HTTP ${resp.status}`)
      }
      return await resp.blob()
    }

    // Bounded-concurrency map. Keeps 4 fetches in-flight at once;
    // pulls the next job from the queue as each resolves. Simpler
    // than pulling in p-limit for a one-off.
    const MAX_PARALLEL = 4
    async function runQueued<T, R>(
      items: T[],
      fn: (item: T) => Promise<R>,
    ): Promise<R[]> {
      const results: R[] = new Array(items.length)
      let cursor = 0
      const worker = async () => {
        while (cursor < items.length) {
          const idx = cursor++
          results[idx] = await fn(items[idx])
        }
      }
      const workers = Array.from(
        { length: Math.min(MAX_PARALLEL, items.length) },
        () => worker(),
      )
      await Promise.all(workers)
      return results
    }

    try {
      // Build the in-UI sort order so the ZIP (and the file order
      // JSZip embeds) reads consistently with what the designer
      // saw on the page. sortedApprovedImages is computed below
      // in the render scope — recompute the same sort here since
      // we can't read render-scope values from this handler.
      const currentVersion = versions.find((v) => v.is_current)
      const nameOrder = new Map<string, number>()
      currentVersion?.names.forEach((n, i) => nameOrder.set(n, i))
      const sorted = [...approvedImages].sort((a, b) => {
        // Shared (null name) first
        const aShared = a.associatedName == null ? 0 : 1
        const bShared = b.associatedName == null ? 0 : 1
        if (aShared !== bShared) return aShared - bShared
        // Then by position in current version's names[]; names
        // that aren't on the current version (cross-version
        // approval edge case) fall to the bottom, stable.
        const aPos = a.associatedName == null ? -1 : nameOrder.get(a.associatedName) ?? Infinity
        const bPos = b.associatedName == null ? -1 : nameOrder.get(b.associatedName) ?? Infinity
        if (aPos !== bPos) return aPos - bPos
        // Front before back within a name. Null side normalises
        // to 'front' for back-compat sort stability.
        const aSide = (a.side ?? 'front') === 'front' ? 0 : 1
        const bSide = (b.side ?? 'front') === 'front' ? 0 : 1
        if (aSide !== bSide) return aSide - bSide
        return a.imageId < b.imageId ? -1 : 1
      })

      const blobs = await runQueued(sorted, (row) => fetchBlob(row.imagePath))

      const zip = new JSZip()

      // Membership detection: every approved image is Shared
      // (associated_name IS NULL). Triggers two changes: images
      // go straight into the ZIP root rather than into a Shared/
      // folder (no hierarchy when there's only one group), and
      // the manifest omits the Name column. Parity with the UI
      // table's Name-column suppression above.
      const isAllShared = approvedImages.every((r) => r.associatedName == null)

      // One folder per identity: {name}/ in Business mode, or no
      // folder (root-level) in Membership mode. Filename is the
      // original, never rewritten. Null original_filename falls
      // back to a synthetic {id-short}.jpg leaf so the ZIP still
      // extracts — designer will have seen the missing filename
      // in the table.
      for (let i = 0; i < sorted.length; i++) {
        const row = sorted[i]
        const leaf =
          row.originalFilename ?? `unnamed-${row.imageId.slice(0, 8)}.jpg`
        if (isAllShared) {
          zip.file(leaf, blobs[i])
        } else {
          const folder = row.associatedName == null ? 'Shared' : row.associatedName
          zip.file(`${folder}/${leaf}`, blobs[i])
        }
      }

      // Manifest: plain-text header block + tab-separated table.
      // UTF-8 (JSZip default). Production uses this to cross-check
      // filename → recipient/side mapping without opening each
      // subfolder. Name column suppressed in membership mode for
      // the same reason as the UI table — one repeating value
      // ("Shared") adds no information.
      const approvedDate = proof.approved_at
        ? formatLongDate(proof.approved_at)
        : '—'
      const currentMaterial = currentVersion?.material_display ?? '—'
      const isOneSided = !approvedImages.some((r) => r.side === 'back')

      const header =
        `Project: ${projectName}\n` +
        `Customer: ${customerName}\n` +
        `Approved: ${approvedDate}\n` +
        `Material: ${currentMaterial}\n\n`

      // Mirror the UI table's identity-column label swap. Read
      // card_type from the current version so "Variant" shows
      // for tiered membership and "Name" stays for business.
      const identityColumnLabel =
        currentVersion?.card_type === 'membership' ? 'Variant' : 'Name'
      const columns: string[] = []
      if (!isAllShared) columns.push(identityColumnLabel)
      if (!isOneSided) columns.push('Side')
      columns.push('Version', 'Filename')
      const manifestLines: string[] = [columns.join('\t')]
      for (const row of sorted) {
        const nameCol = row.associatedName ?? 'Shared'
        const sideCol = (row.side ?? 'front') === 'front' ? 'Front' : 'Back'
        const versionCol = `v${row.versionNumber}`
        const fileCol = row.originalFilename ?? `unnamed-${row.imageId.slice(0, 8)}.jpg`
        const rowCols: string[] = []
        if (!isAllShared) rowCols.push(nameCol)
        if (!isOneSided) rowCols.push(sideCol)
        rowCols.push(versionCol, fileCol)
        manifestLines.push(rowCols.join('\t'))
      }
      zip.file('manifest.txt', header + manifestLines.join('\n') + '\n')

      const zipBlob = await zip.generateAsync({ type: 'blob' })
      downloadBlob(zipBlob, `${projectName} - Approved Artwork.zip`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast(`ZIP download failed: ${message}`)
    } finally {
      setZipPreparing(false)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-gray-900" />
      </div>
    )
  }

  // Inline-edit save handler for internal_notes. Writes the trimmed
  // draft (empty → null) back to the proofs row, audit-logs the
  // change, and refetches the proof so the panel renders the saved
  // value. Errors are surfaced via the existing showToast helper.
  async function saveInternalNotes() {
    if (!proof || notesSaving) return
    const before = proof.internal_notes ?? null
    const trimmed = notesDraft.trim()
    const next = trimmed === '' ? null : trimmed
    if (next === before) {
      // No change — exit edit mode without a write.
      setNotesEditing(false)
      return
    }
    setNotesSaving(true)
    const { error } = await supabase
      .from('proofs')
      .update({ internal_notes: next })
      .eq('id', proof.id)
    setNotesSaving(false)
    if (error) {
      showToast('Failed to save internal notes')
      return
    }
    void logAudit({
      action: 'proof.internal_notes_updated',
      targetType: 'proof',
      targetId: proof.id,
      targetLabel: proof.contacts.full_name,
      beforeValue: { internal_notes: before },
      afterValue: { internal_notes: next },
    })
    setNotesEditing(false)
    if (id) loadProof(id)
  }

  async function copyCustomerUrl() {
    const url = `${window.location.origin}${customerProofPath(proof!.id)}`
    let copiedOk = false
    try {
      await navigator.clipboard.writeText(url)
      copiedOk = true
    } catch {
      // Modern API failed (permissions, insecure context). Try the
      // legacy hidden-input fallback. document.execCommand returns
      // true on success, false otherwise — only flip copiedOk when
      // it actually wrote.
      if (fallbackInputRef.current) {
        fallbackInputRef.current.value = url
        fallbackInputRef.current.select()
        try {
          copiedOk = document.execCommand('copy')
        } catch {
          copiedOk = false
        }
      }
    }
    if (copiedOk) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } else {
      // Surface the failure rather than silently lying about success.
      // Customer URL is the one thing the designer needs to actually
      // get out of the page; a missed copy with no signal sends them
      // off thinking it landed.
      showToast('Couldn\'t copy — please copy the URL from the address bar manually.')
    }
  }

  if (!proof) return null

  const isApproved  = proof.status === 'approved'
  const isDormant   = proof.status === 'dormant'
  const isAbandoned = proof.status === 'abandoned'
  const isLocked    = isApproved || isAbandoned

  const currentVersion = versions.find((v) => v.is_current)
  const currentIsCustomQuote = !!currentVersion?.custom_quote
  // Workflow bucket for the status pill — matches the dashboard. Falls back to
  // the raw status pill until the bucket row loads (or if it can't be read).
  const statusBucket = bucketRow ? proofBucket(bucketRow) : null

  // Override-aware Mark-as-approved confirm copy. Counted from the
  // already-loaded `approvals` state — handleApprove re-fetches
  // before writing, so a stale count here only affects modal copy,
  // not behaviour.
  const pendingChangeRequestsCount = currentVersion
    ? approvals.filter(
        (a) =>
          a.proof_version_id === currentVersion.id &&
          a.state === 'changes_requested',
      ).length
    : 0
  const isApproveOverride = pendingChangeRequestsCount > 0
  const approveMessage = isApproveOverride
    ? `${pendingChangeRequestsCount} recipient${pendingChangeRequestsCount === 1 ? '' : 's'} requested changes on the current version. Mark as approved anyway? This records an override on the timeline. The customer's feedback stays visible in the names rollup.`
    : 'Mark this project as approved? This locks the project — no more proof versions can be added.'
  const approveConfirmClass = isApproveOverride
    ? 'bg-ink hover:opacity-90 text-on-ink'
    : 'bg-in-stock hover:opacity-90 text-on-ink'

  // "Approved on an earlier version" surfacing. A customer can step
  // back to an older version in the selector and approve it (after
  // ticking the earlier-version acknowledgement). That approval lands
  // on the non-current version and never finalizes the proof — the
  // current version stays unapproved, so the proof sits in_progress
  // and the approval looks like it did nothing. Detect it and show a
  // clear banner so the designer isn't left guessing why "approved"
  // didn't stick. Suppressed once the proof is fully approved (the
  // approved state wins) or when there's no current version.
  const staleApprovalSummary = (() => {
    if (isApproved || !currentVersion) return null
    // Names already approved on the current version (carried forward
    // or re-approved) aren't stranded — exclude them.
    const approvedOnCurrent = new Set(
      approvals
        .filter((a) => a.proof_version_id === currentVersion.id && a.state === 'approved')
        .map((a) => a.name),
    )
    const stranded = approvals.filter(
      (a) =>
        a.state === 'approved' &&
        a.proof_version_id !== currentVersion.id &&
        !approvedOnCurrent.has(a.name),
    )
    if (stranded.length === 0) return null
    const byVersion = new Map<
      string,
      { versionNumber: number; material: string | null; names: string[] }
    >()
    for (const a of stranded) {
      const v = versions.find((x) => x.id === a.proof_version_id)
      if (!v) continue
      const entry = byVersion.get(v.id) ?? {
        versionNumber: v.version_number,
        material: v.material_display || null,
        names: [],
      }
      const label = a.name === SHARED_APPROVAL_KEY ? 'Shared artwork' : a.name
      if (!entry.names.includes(label)) entry.names.push(label)
      byVersion.set(v.id, entry)
    }
    if (byVersion.size === 0) return null
    return {
      versions: [...byVersion.values()].sort((x, y) => y.versionNumber - x.versionNumber),
      current: {
        versionNumber: currentVersion.version_number,
        material: currentVersion.material_display || null,
      },
    }
  })()

  // ── Snapshot band (engagement funnel + at-a-glance stats + header
  //    summary line). Derived entirely from data already loaded — views,
  //    approvals, versions, the dashboard-bucket row — so there's no new
  //    fetch. Pure logic lives in src/lib/proofSnapshot.ts; this just
  //    assembles the inputs from the current version's slice of state.
  const currentViews = currentVersion ? (viewsByVersion.get(currentVersion.id) ?? []) : []
  const sentAt = currentVersion
    ? sentEvidenceAt({
        versionReplyAt: currentVersion.last_reply_sent_at,
        versionCreatedAt: currentVersion.created_at,
        helpscoutLastReplyAt: bucketRow?.helpscout_last_reply_at ?? null,
      })
    : null

  // Latest customer response on the CURRENT version, from the already-
  // loaded approvals (one row per recipient per version). Variant-round
  // selections land as a changes_requested __shared__ row, so badge those
  // as "option chosen" rather than "changes requested".
  const currentResponse: { kind: RespondedKind; at: string } | null = (() => {
    if (!currentVersion) return null
    const rows = approvals.filter(
      (a) =>
        a.proof_version_id === currentVersion.id &&
        (a.state === 'approved' || a.state === 'changes_requested'),
    )
    if (rows.length === 0) return null
    const latest = rows.reduce((best, a) =>
      new Date(a.updated_at).getTime() > new Date(best.updated_at).getTime() ? a : best,
    )
    const kind: RespondedKind =
      latest.state === 'approved'
        ? 'approved'
        : currentVersion.is_variant_round
          ? 'selection'
          : 'changes'
    return { kind, at: latest.updated_at }
  })()

  // Per-version rounds for the engagement panel's strip — each version
  // is one send/respond lap of the back-and-forth. A superseded version
  // that drew a change request reads 'changes'; one the customer
  // approved reads 'approved'; one we revised with no response reads
  // 'none'. The current version reads its live state and the funnel
  // below details its sub-state. See ROUND_OUTCOME for the palette.
  const rounds = [...versions]
    .sort((a, b) => a.version_number - b.version_number)
    .map((v) => {
      const rows = approvals.filter((a) => a.proof_version_id === v.id)
      const outcome = roundOutcome({
        isCurrent: v.is_current,
        proofApproved: isApproved,
        hasChanges: rows.some((r) => r.state === 'changes_requested'),
        hasApproved: rows.some((r) => r.state === 'approved'),
      })
      return { id: v.id, versionNumber: v.version_number, isCurrent: v.is_current, outcome }
    })

  const funnelSteps: FunnelStep[] = currentVersion
    ? buildFunnel({
        sentAt,
        viewCount: currentViews.length,
        lastViewedAt: currentViews[0]?.viewed_at ?? null,
        responded: currentResponse,
        // Mirror the header's "Replied by email" pill: when the customer
        // replied on the Help Scout conversation (and we haven't responded
        // since), the funnel's Responded step reads that reply instead of
        // "awaiting reply". Same isCustomerReplied predicate proofBucket uses,
        // so the two can't disagree.
        emailRepliedAt:
          bucketRow && isCustomerReplied(bucketRow)
            ? bucketRow.helpscout_last_customer_reply_at
            : null,
      })
    : []

  const headerSummary = statusBucket
    ? summaryLine({
        bucket: statusBucket.bucket,
        ruleCode: bucketRow?.rule_code ?? null,
        sentAt,
        lastViewedAt: currentViews[0]?.viewed_at ?? null,
        respondedAt: currentResponse?.at ?? null,
        customerRepliedAt: bucketRow?.helpscout_last_customer_reply_at ?? null,
        lastActivityAt,
      })
    : null

  // Latest customer change-request comment on the current version, for
  // the action-needed strip. The timeline events already carry the
  // comment text, so no extra fetch — null when none has a comment.
  const latestChangeRequest = currentVersion
    ? (timelineEvents
        .filter(
          (e) =>
            e.proof_version_id === currentVersion.id &&
            e.event_type === 'request_changes',
        )
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] ?? null)
    : null

  const quantityRange = currentVersion
    ? quantityRangeLabel({
        customQuote: currentVersion.custom_quote,
        perDirectionPricing: currentVersion.is_per_direction_pricing,
        quantities: currentVersion.materials?.display_quantities ?? null,
      })
    : null

  const totalViews = totalNonBotViews(viewsByVersion)
  const showActionStrip = statusBucket?.bucket === 'changes_requested'

  // Joins a list of names British-style: "A", "A and B", "A, B and C".
  const joinNames = (names: string[]): string =>
    names.length <= 1
      ? names[0] ?? ''
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

  // ── Panels for the two-column layout ────────────────────────────────
  // Built as element consts so the skeleton in the return below can
  // place them across the main column and the meta rail without
  // threading the (often large) JSX through the layout. Each bakes in
  // its own visibility gate and returns null when empty, so the column
  // just renders {panel}.

  const heroPanel = currentVersion ? (
    <section className="overflow-hidden rounded-[14px] border border-line bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="eyebrow text-ink-mute">Current proof</span>
          <span className="font-mono text-[13px] font-semibold text-ink">v{currentVersion.version_number}</span>
        </div>
        <span className="truncate text-[12px] text-ink-mute" title={currentVersion.material_display}>
          {currentVersion.material_display}
        </span>
      </div>
      {heroImages.length > 0 ? (
        <button
          type="button"
          onClick={() => setSelectedVersion(currentVersion)}
          title="Open version detail"
          aria-label={`Open version ${currentVersion.version_number} detail`}
          className="block w-full text-left focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--c-brand)]"
        >
          <div className={['grid gap-2 p-3', heroImages.length > 1 ? 'grid-cols-2' : 'grid-cols-1'].join(' ')}>
            {heroImages.map((img, i) => (
              <div
                key={i}
                className="relative overflow-hidden rounded-[8px] bg-ink"
              >
                <img
                  src={img.url}
                  alt={img.side === 'back' ? 'Back of the card' : 'Front of the card'}
                  loading="lazy"
                  className="block w-full"
                />
                {heroImages.length > 1 && (
                  <span
                    className="absolute bottom-1.5 left-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider"
                    style={{ backgroundColor: 'rgba(22,19,17,0.72)', color: '#fff' }}
                  >
                    {img.side === 'back' ? 'Back' : 'Front'}
                  </span>
                )}
              </div>
            ))}
          </div>
        </button>
      ) : (
        <div className="p-8 text-center">
          <p className="text-[13px] text-ink-mute">No artwork uploaded to v{currentVersion.version_number} yet.</p>
        </div>
      )}
    </section>
  ) : null

  const funnelPanel = currentVersion ? (
    <section className="rounded-[14px] border border-line bg-surface p-4">
      {/* Header row — round count (or "Progress" for a one-round proof)
          plus a "?" toggle that reveals a short explainer, so a designer
          seeing the panel for the first time knows what they're reading
          without it cluttering the view once they do. */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="eyebrow text-ink-mute">
          {rounds.length >= 2 ? `${rounds.length} rounds` : 'Progress'}
        </span>
        <button
          type="button"
          onClick={() => setFunnelHelpOpen((o) => !o)}
          aria-expanded={funnelHelpOpen}
          aria-label="What does this show?"
          title="What does this show?"
          className="inline-flex h-5 w-5 items-center justify-center rounded text-ink-mute transition-colors hover:bg-canvas hover:text-ink"
        >
          <HelpCircle size={15} aria-hidden="true" />
        </button>
      </div>

      {funnelHelpOpen && (
        <div className="mb-4 rounded-[10px] bg-canvas px-3 py-2.5 text-[12px] leading-[1.6] text-ink-soft">
          {rounds.length >= 2 && (
            <p>
              <span className="font-semibold text-ink">Rounds</span> — each version is one round of
              feedback. <span style={{ color: 'var(--c-low)' }}>Amber</span> = changes requested,{' '}
              <span style={{ color: 'var(--c-in-stock)' }}>green</span> = approved,{' '}
              <span style={{ color: 'var(--c-allocated)' }}>blue</span> = the current version. Click a
              version to open it.
            </p>
          )}
          <p className={rounds.length >= 2 ? 'mt-1.5' : ''}>
            <span className="font-semibold text-ink">This round</span> — how far the current version
            has got: <span className="font-medium text-ink">Sent</span> to the customer →{' '}
            <span className="font-medium text-ink">Viewed</span> (counts page loads, the customer
            only) → <span className="font-medium text-ink">Responded</span>. Green steps are done;
            blue is what we're waiting on the customer for.
          </p>
        </div>
      )}

      {/* Rounds strip — one chip per version, so the back-and-forth is
          visible instead of implied. Shown only from the second round;
          a first-round proof is just the funnel below. Each chip opens
          that version's detail. */}
      {rounds.length >= 2 && (
        <div className="mb-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {rounds.map((r, i) => {
              const pal = ROUND_OUTCOME[r.outcome]
              return (
                <Fragment key={r.id}>
                  {i > 0 && <ChevronRight size={14} className="shrink-0 text-ink-dim" aria-hidden="true" />}
                  <button
                    type="button"
                    onClick={() => {
                      const v = versions.find((x) => x.id === r.id)
                      if (v) setSelectedVersion(v)
                    }}
                    title={`Open v${r.versionNumber} detail`}
                    aria-label={`Version ${r.versionNumber}, ${pal.label}`}
                    className="flex flex-col items-center gap-0.5 rounded-[8px] px-3 py-1.5 transition-opacity hover:opacity-80 focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-brand)]"
                    style={{
                      backgroundColor: pal.bg,
                      ...(r.isCurrent ? { boxShadow: `inset 0 0 0 2px ${pal.color}` } : {}),
                    }}
                  >
                    <span className="font-mono text-[12px] font-semibold" style={{ color: pal.color }}>
                      v{r.versionNumber}
                    </span>
                    <span className="text-[10px] leading-none" style={{ color: pal.color }}>{pal.label}</span>
                  </button>
                </Fragment>
              )
            })}
          </div>
        </div>
      )}
      {rounds.length >= 2 && (
        <div className="eyebrow mb-2 text-ink-mute">v{currentVersion.version_number} · this round</div>
      )}
      <div className="flex items-stretch gap-1.5">
        {funnelSteps.map((step, i) => {
          const palette =
            step.state === 'done'
              ? { color: 'var(--c-in-stock)', bg: 'var(--c-in-stock-soft)' }
              : step.state === 'active'
                ? { color: 'var(--c-allocated)', bg: 'var(--c-allocated-soft)' }
                : { color: 'var(--c-ink-dim)', bg: 'var(--c-line-soft)' }
          const Icon = step.key === 'sent' ? Send : step.key === 'viewed' ? Eye : MessageSquare
          const sub = step.at ? relativeTime(step.at) : step.note
          return (
            <Fragment key={step.key}>
              {i > 0 && (
                <div className="flex items-center text-ink-dim" aria-hidden="true">
                  <ChevronRight size={16} />
                </div>
              )}
              <div className="flex-1 rounded-[10px] px-3 py-2.5 text-center" style={{ backgroundColor: palette.bg }}>
                <Icon size={16} aria-hidden="true" className="mx-auto" style={{ color: palette.color }} />
                <div className="mt-1 text-[12px] font-semibold" style={{ color: palette.color }}>{step.label}</div>
                {sub && <div className="mt-0.5 text-[11px] text-ink-mute">{sub}</div>}
              </div>
            </Fragment>
          )
        })}
      </div>
    </section>
  ) : null

  const statsPanel = currentVersion ? (
    <section className="rounded-[14px] border border-line bg-surface p-4">
      <div className="grid grid-cols-2 gap-2">
        {[
          { icon: Clock, label: 'Age', value: `${ageDays(proof.created_at, Date.now())}d` },
          { icon: Activity, label: 'Last activity', value: lastActivityAt ? relativeTime(lastActivityAt) : '—' },
          { icon: Eye, label: 'Total views', value: String(totalViews) },
          { icon: Package, label: 'Quantity', value: quantityRange ?? '—' },
        ].map(({ icon: Icon, label, value }) => (
          <div key={label} className="rounded-[10px] bg-canvas px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-ink-mute">
              <Icon size={12} aria-hidden="true" />
              <span className="eyebrow">{label}</span>
            </div>
            <div className="mt-1 text-[17px] font-semibold leading-tight text-ink">{value}</div>
          </div>
        ))}
      </div>
    </section>
  ) : null

  const factsPanel = (
    <section className="rounded-[14px] border border-line bg-surface p-4">
      <dl className="space-y-3">
        <div className="min-w-0">
          <dt className="eyebrow text-ink-mute">Public URL</dt>
          <dd className="mt-1 flex items-center gap-2">
            <span className="truncate font-mono text-[12px] text-ink-soft">
              proofs.plasmadesign.co.uk{customerProofPath(proof.id)}
            </span>
            <button
              type="button"
              onClick={copyCustomerUrl}
              title="Copy customer URL"
              aria-label="Copy customer URL"
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-mute transition-colors hover:bg-canvas hover:text-ink"
            >
              {copied ? <CheckIcon size={13} style={{ color: 'var(--c-in-stock)' }} /> : <Copy size={13} />}
            </button>
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="eyebrow text-ink-mute">Help Scout</dt>
          <dd className="mt-1 flex items-center gap-2 text-[13px]">
            {proof.helpscout_conversation_url ? (
              <a href={proof.helpscout_conversation_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-ink-soft hover:text-ink">
                Open conversation <ExternalLink size={11} aria-hidden="true" />
              </a>
            ) : proof.helpscout_thread_url ? (
              <a href={proof.helpscout_thread_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-ink-soft hover:text-ink">
                Open thread <ExternalLink size={11} aria-hidden="true" />
              </a>
            ) : proof.helpscout_override_reason ? (
              <span className="italic text-ink-mute" title={`Override reason: ${proof.helpscout_override_reason}`}>
                Override: {proof.helpscout_override_reason}
              </span>
            ) : (
              <span className="italic text-ink-mute">Not linked</span>
            )}
            <button
              type="button"
              onClick={() => setShowHelpscoutEdit(true)}
              title="Change Help Scout conversation"
              aria-label="Change Help Scout conversation"
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-mute transition-colors hover:bg-canvas hover:text-ink"
            >
              <Pencil size={12} />
            </button>
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="eyebrow text-ink-mute">Created</dt>
          <dd className="mt-1 text-[13px] text-ink-soft">{formatLongDate(proof.created_at)}</dd>
        </div>
      </dl>
    </section>
  )

  const internalNotesPanel = (
    <section className="rounded-[14px] border border-line bg-surface px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FileText size={13} className="shrink-0 text-ink-mute" aria-hidden="true" />
            <span className="eyebrow text-ink-mute">Internal notes</span>
          </div>
          <p className="mt-1 text-[11px] text-ink-mute">Not visible to the customer</p>
        </div>
        {!notesEditing && (
          <button
            type="button"
            onClick={() => {
              setNotesDraft(proof.internal_notes ?? '')
              setNotesEditing(true)
            }}
            title={proof.internal_notes ? 'Edit notes' : 'Add notes'}
            aria-label={proof.internal_notes ? 'Edit internal notes' : 'Add internal notes'}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-mute transition-colors hover:bg-canvas hover:text-ink"
          >
            <Pencil size={12} />
          </button>
        )}
      </div>
      {notesEditing ? (
        <div className="mt-2">
          <textarea
            value={notesDraft}
            onChange={(e) => setNotesDraft(e.target.value)}
            rows={4}
            placeholder="Notes about this project — only visible to designers."
            className="w-full resize-none rounded-md border border-line bg-surface px-3 py-2 text-[13px] leading-[1.55] text-ink-soft placeholder:text-ink-dim focus:border-[var(--c-brand)] focus:outline focus:outline-2 focus:outline-offset-[-1px] focus:outline-[var(--c-brand)]"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setNotesEditing(false)
                setNotesDraft('')
              }}
              disabled={notesSaving}
              className="text-[12px] text-ink-mute hover:text-ink-soft disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void saveInternalNotes()}
              disabled={notesSaving}
              className="rounded bg-ink px-3 py-1.5 text-[12px] font-medium text-on-ink hover:opacity-90 disabled:opacity-50"
            >
              {notesSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      ) : proof.internal_notes ? (
        <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-[1.55] text-ink-soft">{proof.internal_notes}</p>
      ) : (
        <p className="mt-1.5 text-[13px] italic text-ink-mute">No internal notes yet. Click the pencil to add some.</p>
      )}
    </section>
  )

  const customerReplyPanel = (() => {
    if (!currentVersion) return null
    if (isLocked) return null
    const hasHs = !!proof.helpscout_conversation_id
    const lastSentIso = currentVersion.last_reply_sent_at
    const repliesPaused = repliesEnabled === false
    const pausedNote =
      role === 'admin'
        ? 'Replies are currently paused. Enable in Settings.'
        : 'Replies are currently paused.'
    return (
      <section className="rounded-[14px] border border-line bg-surface p-4">
        <p className="eyebrow text-ink-mute">Customer reply</p>
        {!hasHs ? (
          <div className="mt-2">
            <p className="text-[13px] text-ink-mute">
              No Help Scout conversation linked. Add one from the Help Scout row to enable replies.
            </p>
            <button
              type="button"
              disabled
              className="mt-2 cursor-not-allowed rounded bg-line px-4 py-2 text-sm font-semibold text-ink-dim"
            >
              Send reply
            </button>
          </div>
        ) : lastSentIso ? (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <p className="text-[13px] text-ink-soft">
              Reply sent{' '}
              <span title={formatAbsoluteDateTime(lastSentIso)} className="font-medium text-ink">
                {relativeTime(lastSentIso)}
              </span>{' '}
              for v{currentVersion.version_number}.
            </p>
            <button
              type="button"
              onClick={() => setShowResendConfirm(true)}
              disabled={repliesPaused}
              title={repliesPaused ? pausedNote : undefined}
              className={[
                'shrink-0 rounded px-4 py-2 text-sm font-medium ring-1',
                repliesPaused
                  ? 'cursor-not-allowed bg-canvas text-ink-dim ring-line-soft'
                  : 'text-ink-soft ring-line hover:bg-canvas',
              ].join(' ')}
            >
              Send again
            </button>
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <p className="text-[13px] text-ink-mute">No reply sent yet for v{currentVersion.version_number}.</p>
            <button
              type="button"
              onClick={() => setShowReplyModal(true)}
              disabled={repliesPaused}
              title={repliesPaused ? pausedNote : undefined}
              className={[
                'shrink-0 rounded px-4 py-2 text-sm font-semibold',
                repliesPaused ? 'cursor-not-allowed bg-line text-ink-dim' : 'bg-ink text-on-ink hover:opacity-90',
              ].join(' ')}
            >
              Send reply
            </button>
          </div>
        )}
        {repliesPaused && hasHs && <p className="mt-2 text-xs text-low">{pausedNote}</p>}
      </section>
    )
  })()

  const timelinePanel = (
    <ProofTimeline
      proof={{
        created_at: proof.created_at,
        approved_at: proof.approved_at,
        abandoned_at: proof.abandoned_at,
        disclaimer_acknowledged_at: proof.disclaimer_acknowledged_at,
        contactName: proof.contacts.full_name,
      }}
      versions={versions}
      events={timelineEvents}
      viewsByVersion={viewsByVersion}
      designerNamesById={designerNames}
      proofId={proof.id}
      hasHelpScout={!!proof.helpscout_conversation_id}
    />
  )

  return (
    <DesignerChrome active="proofs">
    <div className="min-h-dvh bg-canvas">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">

        {/* Breadcrumb — Proofs › <Customer name>. Replaces the old
            "← Back to projects" link; the chrome handles QuoteLink
            and nav so this row carries the page's hierarchy only. */}
        <nav className="mb-6 flex items-center gap-1.5 text-[13px]">
          <Link to="/" className="text-ink-mute hover:text-ink transition-colors">Proofs</Link>
          <ChevronRight size={14} className="text-ink-dim" aria-hidden="true" />
          <span className="text-ink-soft truncate">{proof.contacts.full_name}</span>
        </nav>

        {/* Header card — bordered, status-rule on the left, customer
            identity + KV row on the left half, status pill + actions
            on the right half. Replaces the prior split header / status
            badges / two-row action cluster. */}
        <section
          className="mb-6 relative bg-surface border border-line border-l-[10px] rounded-[14px] overflow-hidden"
          style={{
            // Left cap colour follows the dashboard row + tile palette
            // so the status accent reads in the same hue everywhere it
            // appears.
            borderLeftColor:
              isApproved      ? 'var(--c-in-stock)' :
              isAbandoned     ? 'var(--c-ink-mute)' :
              isDormant       ? 'var(--c-ink-dim)' :
                                'var(--c-allocated)',
          }}
        >
          <div className="px-7 py-6 flex flex-wrap items-start gap-6 justify-between">
            {/* Left: identity + KV row */}
            <div className="min-w-0 flex-1">
              {/* Identity — favour the company name when present (matches
                  the dashboard + customer page); the contact name drops
                  to the subline. Sole traders (company === contact name)
                  show a single line. */}
              <div className="eyebrow">Customer</div>
              {(() => {
                const company = proof.contacts.companies?.name?.trim()
                const person = proof.contacts.full_name
                const primary = company || person
                const secondary = company && company !== person ? person : null
                return (
                  <>
                    <h1 className="mt-1.5 font-display font-medium tracking-[-0.02em] text-ink leading-tight m-0" style={{ fontSize: 'clamp(28px, 4vw, 36px)' }}>
                      {primary}
                    </h1>
                    {secondary && (
                      <p className="mt-1 text-[14px] text-ink-mute leading-snug">{secondary}</p>
                    )}
                  </>
                )
              })()}
              {/* State summary — one plain-English line turning the
                  status pill's category into "what's happening + since
                  when". summaryLine() returns null for terminal states
                  (approved / abandoned / dormant / snoozed), so this
                  only shows for the active workflow states where the
                  pill alone doesn't say how long it's been waiting. */}
              {headerSummary && (
                <p className="mt-2 text-[13px] text-ink-soft">
                  {headerSummary.lead}
                  {headerSummary.at && (
                    <span className="text-ink-mute" title={formatAbsoluteDateTime(headerSummary.at)}>
                      {' '}· {relativeTime(headerSummary.at)}
                    </span>
                  )}
                </p>
              )}

              {/* Helper notes — dormant warning, disclaimer
                  acknowledgement. */}
              {isDormant && (
                <p className="mt-2 text-[12px] text-ink-mute">
                  No activity for 30+ days. Add a version to reactivate.
                </p>
              )}
              {proof.disclaimer_acknowledged_at && (
                <p className="mt-2 text-[12px] text-ink-mute">
                  Terms acknowledged on {formatLongDate(proof.disclaimer_acknowledged_at)} at{' '}
                  {new Date(proof.disclaimer_acknowledged_at).toLocaleTimeString('en-GB', {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                  })}
                </p>
              )}

            </div>

            {/* Right: status pill + primary actions + destructive row. */}
            <div className="flex flex-col items-end gap-3 shrink-0">
              <div className="flex items-center gap-2">
                {statusBucket
                  ? (statusBucket.bucket === 'needs_attention' && bucketRow?.rule_code
                      ? (
                        <ResolvePopover
                          proofId={proof.id}
                          ruleCode={bucketRow.rule_code}
                          meta={bucketRow.rule_meta}
                          helpscoutUrl={proof.helpscout_conversation_url}
                          hasHelpscoutConversation={!!proof.helpscout_conversation_id}
                          versionId={currentVersion?.id ?? null}
                          versionNumber={currentVersion?.version_number ?? null}
                          contactFullName={proof.contacts.full_name}
                          companyName={proof.contacts.companies?.name ?? null}
                          onSnoozed={() => { if (id) loadProof(id) }}
                          className="cursor-pointer"
                        >
                          <ProofStatusPill label={statusBucket.label} colour={statusBucket.colour} />
                        </ResolvePopover>
                      )
                      : <ProofStatusPill label={statusBucket.label} colour={statusBucket.colour} />)
                  : <ProofStatusPill status={proof.status} />}
                {currentIsCustomQuote && (
                  <span
                    className="pill"
                    style={{
                      backgroundColor: 'var(--c-line-soft)',
                      color: 'var(--c-ink-mute)',
                    }}
                  >
                    Custom quote
                  </span>
                )}
              </div>
              {/* Single action row: the two everyday actions stay
                  visible — Add new version (coral primary) + Open
                  customer view (ghost) — and the terminal state changes
                  (Mark as approved / Abandon, or Reopen when locked)
                  move into a quiet overflow menu so they no longer
                  compete with the everyday actions for attention. */}
              <div className="flex items-center gap-2">
                {!isLocked && (
                  <ButtonCoral
                    icon={Plus}
                    onClick={() => navigate(`/proofs/${proof.id}/versions/new`)}
                  >
                    Add a new version
                  </ButtonCoral>
                )}
                {/* Create order — only on approved proofs, and only when
                    the ordering master switch is on (settings.ordering_enabled,
                    migration 000228). For an approved proof this is the
                    primary action; the whole surface is inert until an admin
                    flips the toggle. */}
                {isApproved && orderingEnabled === true && (
                  <ButtonCoral
                    icon={Package}
                    onClick={() => setShowOrderBuilder(true)}
                  >
                    Create order
                  </ButtonCoral>
                )}
                <ButtonGhost
                  icon={ExternalLink}
                  disabled={versions.length === 0}
                  title={versions.length === 0 ? 'Add a version to enable preview' : undefined}
                  onClick={() => {
                    // Open the customer page in a new tab, falling back
                    // to same-tab navigation when the tab is blocked (a
                    // popup blocker, or a sandboxed embed without allow-
                    // popups) so the button never silently does nothing.
                    openDesignerPreview(proof.id)
                  }}
                >
                  Open customer view
                </ButtonGhost>
                <HeaderActionsMenu
                  items={
                    isLocked
                      ? [{ label: 'Reopen project', onClick: () => setStatusDialog('reopen') }]
                      : [
                          { label: 'Mark as approved', tone: 'approve', onClick: () => setStatusDialog('approve') },
                          { label: 'Abandon project', tone: 'danger', onClick: () => setStatusDialog('abandon') },
                        ]
                  }
                />
              </div>
            </div>
          </div>

          {/* Hidden input for clipboard fallback. */}
          <input ref={fallbackInputRef} className="sr-only" readOnly aria-hidden="true" />
        </section>

        {/* "Approved on an earlier version" warning. Surfaces the
            silent dead-end where a customer approved a superseded
            version while the current version is still unapproved, so
            the proof never finalizes. */}
        {staleApprovalSummary && (
          <section className="mb-8 rounded-2xl border border-low bg-low-soft p-5">
            <div className="flex items-start gap-3">
              <AlertTriangle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-low" />
              <div className="min-w-0 text-[13px] leading-[1.6] text-ink-soft">
                <p className="font-semibold text-ink">Customer approved a non-current version</p>
                <p className="mt-1">
                  {staleApprovalSummary.versions.map((v, i) => (
                    <span key={v.versionNumber}>
                      {i > 0 && '; '}
                      {joinNames(v.names)} approved <strong>v{v.versionNumber}</strong>
                      {v.material ? ` (${v.material})` : ''}
                    </span>
                  ))}
                  , but <strong>v{staleApprovalSummary.current.versionNumber}</strong>
                  {staleApprovalSummary.current.material
                    ? ` (${staleApprovalSummary.current.material})`
                    : ''}{' '}
                  is the current version and hasn’t been approved.
                </p>
                <p className="mt-1.5 text-ink-mute">
                  The proof won’t show as approved until the current version is approved. The
                  customer may be choosing that design — check with them, or open that
                  version and “Set as current” if it’s the one they want.
                </p>
              </div>
            </div>
          </section>
        )}

        {/* Action-needed strip — pulls the customer's outstanding change
            request up to the top of the page (it otherwise lives buried
            in the Names rollup). Only renders when the proof is in the
            changes_requested bucket and isn't locked, so a proof we've
            already answered with a fresh version (awaiting_customer)
            doesn't show a false alarm. The comment text comes from the
            already-loaded timeline events — no extra fetch. */}
        {showActionStrip && !isLocked && currentVersion && (
          <section className="mb-8 rounded-2xl border border-low bg-low-soft p-5">
            <div className="flex items-start gap-3">
              <MessageSquare aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-low" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-low">
                    Customer requested changes
                  </p>
                  {latestChangeRequest && (
                    <span className="text-[12px] text-ink-mute">
                      {latestChangeRequest.name && latestChangeRequest.name !== SHARED_APPROVAL_KEY
                        ? `${latestChangeRequest.name} · `
                        : ''}
                      v{currentVersion.version_number} · {relativeTime(latestChangeRequest.created_at)}
                    </span>
                  )}
                </div>
                {latestChangeRequest?.comment ? (
                  <p className="mt-2 text-[14px] leading-[1.55] text-ink-soft">
                    “{latestChangeRequest.comment}”
                  </p>
                ) : (
                  <p className="mt-2 text-[13px] text-ink-mute">
                    The customer asked for changes on v{currentVersion.version_number}. See the
                    Names section below for the detail.
                  </p>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <ButtonCoral
                    icon={Plus}
                    size="sm"
                    onClick={() => navigate(`/proofs/${proof.id}/versions/new`)}
                  >
                    Add a new version
                  </ButtonCoral>
                  {proof.helpscout_conversation_url && (
                    <a
                      href={proof.helpscout_conversation_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[13px] text-ink-soft hover:text-ink"
                    >
                      Reply in Help Scout <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  )}
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Two-column layout — the main column carries the artwork +
            progress + the version/approval detail; the meta rail on the
            right carries the at-a-glance stats, facts, internal notes,
            reply status and history. Stacks to one column below lg. */}
        <div className="lg:grid lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)] lg:gap-8 lg:items-start">
          {/* ── Main column ───────────────────────────────────────── */}
          <div className="min-w-0 space-y-8">
            {heroPanel}
            {funnelPanel}

        {/* Hosted-vCard snapshot, current version only.
            The edge function (migration 000194) writes qr_snapshot
            onto the proof_name_approvals row it touched at approve
            time. Which row depends on the proof's shape:
              * Split-name (current.names not empty) → one row per
                named recipient, keyed by name. Multiple snapshots
                render side-by-side when more than one named
                recipient has a hosted-vCard QR.
              * Shared / no-names one-off → a single __shared__ row.
              * Membership (card_type === 'membership') → also a
                single __shared__ row; the Names rollup section
                below skips membership entirely, so this section
                is the only place a designer can see what was
                approved on a membership card.
            We render this as its own section ABOVE the rollup so
            the three shapes share one display path; the inline
            "expand to see snapshot" affordance the rollup used to
            host has been removed to keep the surface single-rooted
            and avoid double-rendering for the named case. */}
        {(() => {
          const currentVersion = versions.find((v) => v.is_current)
          if (!currentVersion) return null
          const entries = approvals
            .filter(
              (a) =>
                a.proof_version_id === currentVersion.id &&
                a.state === 'approved' &&
                a.qr_snapshot &&
                Object.keys(a.qr_snapshot).length > 0,
            )
            // Render named rows first (alphabetical / version-name
            // order), the __shared__ sentinel last — matches the
            // Names rollup ordering convention so designers scan
            // both sections the same way.
            .sort((a, b) => {
              if (a.name === SHARED_APPROVAL_KEY && b.name !== SHARED_APPROVAL_KEY) return 1
              if (a.name !== SHARED_APPROVAL_KEY && b.name === SHARED_APPROVAL_KEY) return -1
              return a.name.localeCompare(b.name)
            })
          if (entries.length === 0) return null
          const sharedHeading =
            currentVersion.card_type === 'membership' ? 'Membership card' : 'Shared'
          return (
            <section>
              <h2 className="mb-1 text-sm font-semibold uppercase tracking-widest text-ink-dim">
                Approved vCard contents
              </h2>
              <p className="mb-4 text-xs text-ink-mute">
                Captured at approval time. The live vCard may have changed since.
              </p>
              <div className="space-y-3">
                {entries.map((approval) => {
                  const heading =
                    approval.name === SHARED_APPROVAL_KEY ? sharedHeading : approval.name
                  const when = new Date(approval.updated_at).toLocaleDateString('en-GB')
                  return (
                    <div
                      key={approval.id}
                      className="overflow-hidden rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-line"
                    >
                      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
                        <p className="text-sm font-semibold text-ink">{heading}</p>
                        <p className="text-xs text-ink-mute">
                          Approved {when} by {approval.actor_name}
                        </p>
                      </div>
                      <VcardSnapshotPanel snapshot={approval.qr_snapshot!} />
                    </div>
                  )
                })}
              </div>
            </section>
          )
        })()}

        {/* Names roll-up — aggregate per-name approval state across
            the project's version history, plus a Shared row when the
            current version has shared images. Renders if either
            there's at least one named recipient OR there are shared
            images to approve; fully-empty current versions skip it.
            Scope is the current version's names[] (past-version-only
            names that have since been dropped aren't shown) plus the
            sentinel key for Shared. Per-entry state is the latest
            approval row across ALL versions of this project, so a
            name approved in v2 still reads as approved here even if
            v3 (current) has no entry yet.
            Membership-card proofs skip the section entirely — they
            have no recipient concept, so a lone "Shared / Pending"
            row is placeholder noise. Gated on the CURRENT version's
            card_type, not "any version", because mode is conceptually
            per-version even though in practice designers don't
            switch modes mid-project. */}
        {(() => {
          const currentVersion = versions.find((v) => v.is_current)
          if (!currentVersion) return null
          if (currentVersion.card_type === 'membership') return null
          const hasShared = versionsWithShared.has(currentVersion.id)
          if (currentVersion.names.length === 0 && !hasShared) return null

          // Build a version-id → version-number map so the "in vN"
          // tail on each state line can reference the version the
          // approval was recorded against. Reads straight from the
          // already-loaded versions state, no extra query.
          const versionNumberById = new Map<string, number>()
          for (const v of versions) versionNumberById.set(v.id, v.version_number)

          // For each approval key (names + optional Shared sentinel),
          // find the latest approval row across the whole project.
          // Reduction is O(n) per key over the flat approvals array,
          // which is small (one row per recipient per version).
          // `heading` is the display label; `key` is the sentinel or
          // name used to match approval rows. Shared goes last per
          // spec — a visual divider at render time sets it apart
          // from the per-name rows above.
          type RollupEntry =
            | { kind: 'name'; key: string; heading: string; approval: ProofNameApproval | null }
            | {
                kind: 'shared'
                key: typeof SHARED_APPROVAL_KEY
                heading: 'Shared'
                derived: SharedApprovalState
                versionNumber: number
              }
          const rollupEntries: RollupEntry[] =
            currentVersion.names.map((name): RollupEntry => {
              const forThisName = approvals.filter((a) => a.name === name)
              const approval = forThisName.length === 0
                ? null
                : forThisName.reduce((best, a) =>
                    new Date(a.updated_at).getTime() > new Date(best.updated_at).getTime() ? a : best,
                  )
              return { kind: 'name', key: name, heading: name, approval }
            })
          if (hasShared) {
            // Shared is implicit-approved when every name on the
            // current version has an approved row on the current
            // version. Predicate + max(updated_at) sourced together
            // from the same scoped slice of proof_name_approvals.
            // Legacy __shared__ rows are deliberately excluded — the
            // sentinel still gets written by the all-shared one-off
            // path on the customer page, but the split-name case
            // derives Shared instead of reading it.
            const approvedNames = new Set<string>()
            const timestampByName = new Map<string, string>()
            for (const a of approvals) {
              if (a.proof_version_id !== currentVersion.id) continue
              if (a.state !== 'approved') continue
              if (a.name === SHARED_APPROVAL_KEY) continue
              approvedNames.add(a.name)
              timestampByName.set(a.name, a.updated_at)
            }
            const derived = deriveSharedApprovalState({
              names: currentVersion.names,
              approvedNames,
              timestampByName,
            })
            rollupEntries.push({
              kind: 'shared',
              key: SHARED_APPROVAL_KEY,
              heading: 'Shared',
              derived,
              versionNumber: currentVersion.version_number,
            })
          }

          return (
            <section>
              <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-ink-dim">Names</h2>
              <div className="overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-line">
                {rollupEntries.map((entry, i) => {
                  const isSharedRow = entry.kind === 'shared'
                  // Row separator: a stronger border above Shared
                  // than between name rows, mirroring the modal's
                  // visual distinction between per-name cards and
                  // the Shared block.
                  const separator = i === 0
                    ? ''
                    : isSharedRow
                    ? 'border-t border-line'
                    : 'border-t border-line-soft'

                  if (entry.kind === 'shared') {
                    // Derived row — no actor name, no carry pill, no
                    // audit toggle. Shared has no own approval event
                    // to expand; the per-name rows above already
                    // surface that detail.
                    const when = entry.derived.latestApprovedAt
                      ? new Date(entry.derived.latestApprovedAt).toLocaleDateString('en-GB')
                      : null
                    // Variant-round selection (000139). When the
                    // current version is a variant round, every
                    // customer "Choose this direction" submission
                    // lands on proof_name_approvals as a
                    // (currentVersion, '__shared__', changes_requested)
                    // row. The derived approved/pending pill above
                    // doesn't cover that state, so we look it up
                    // directly here and render a variant-flavoured
                    // pill instead.
                    const sharedSelection = approvals.find(
                      (a) =>
                        a.proof_version_id === currentVersion.id &&
                        a.name === SHARED_APPROVAL_KEY &&
                        a.state === 'changes_requested',
                    )
                    const sharedSelectionEvent = sharedSelection
                      ? eventsByVersionAndName.get(
                          `${currentVersion.id}|${SHARED_APPROVAL_KEY}`,
                        )
                      : undefined
                    const sharedSelectionWhen = sharedSelection
                      ? new Date(sharedSelection.updated_at).toLocaleDateString('en-GB')
                      : null
                    return (
                      <div key={entry.key} className={['px-5 py-3', separator].join(' ')}>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <p className="text-sm font-semibold text-ink">{entry.heading}</p>
                          {!sharedSelection && entry.derived.state === 'pending' && (
                            <span className="text-xs font-medium text-ink-mute">Pending</span>
                          )}
                          {!sharedSelection && entry.derived.state === 'approved' && (
                            <span className="inline-flex items-center gap-2 text-xs font-medium text-in-stock">
                              <span className="inline-block h-2 w-2 rounded-full bg-in-stock" aria-hidden="true" />
                              Approved in v{entry.versionNumber}{when ? `, ${when}` : ''}
                            </span>
                          )}
                          {sharedSelection && (
                            <span className="inline-flex items-center gap-2 text-xs font-medium text-low">
                              <span className="inline-block h-2 w-2 rounded-full bg-low" aria-hidden="true" />
                              {sharedSelectionEvent?.variant_display_name ? (
                                <>
                                  Direction selected:{' '}
                                  <strong className="font-semibold">
                                    {sharedSelectionEvent.variant_display_name}
                                  </strong>
                                  {' '}in v{entry.versionNumber}
                                  {sharedSelectionWhen ? `, ${sharedSelectionWhen}` : ''}
                                  {' '}by {sharedSelection.actor_name}
                                </>
                              ) : (
                                <>
                                  Changes requested in v{entry.versionNumber}
                                  {sharedSelectionWhen ? `, ${sharedSelectionWhen}` : ''}
                                  {' '}by {sharedSelection.actor_name}
                                </>
                              )}
                            </span>
                          )}
                        </div>
                        {sharedSelection?.change_request && (
                          <p className="mt-1 text-xs text-ink-mute">{sharedSelection.change_request}</p>
                        )}
                      </div>
                    )
                  }

                  const { key, heading, approval } = entry
                  const when = approval ? new Date(approval.updated_at).toLocaleDateString('en-GB') : null
                  const vNum = approval ? versionNumberById.get(approval.proof_version_id) : null
                  const vRef = vNum != null ? `v${vNum}` : '—'
                  // Phase 2 Prompt 8 audit detail: pull the latest
                  // event for this (version, name) pair if one
                  // exists. Designer-recorded approvals (no event
                  // row) skip the expand affordance entirely —
                  // there's nothing customer-side to show.
                  const auditKey = approval
                    ? `${approval.proof_version_id}|${key}`
                    : null
                  const auditEvent = auditKey ? eventsByVersionAndName.get(auditKey) : undefined
                  const expanded = expandedAuditKey === auditKey
                  // Override events deliberately don't post to Help
                  // Scout; null thread id is expected for those, not
                  // a failure. The "!" badge stays suppressed.
                  const hsFailed = !!(
                    auditEvent
                    && auditEvent.event_type !== 'designer_override_approve'
                    && auditEvent.helpscout_thread_id == null
                  )
                  // Override row (000129): state has flipped to
                  // 'approved' but the row preserves the customer's
                  // original actor_name and change_request so the
                  // rollup can surface "(originally requested
                  // changes by …)".
                  const isOverride = approval?.overridden_from_state === 'changes_requested'
                  // Designer who recorded the override comes from the
                  // matching proof_events row. Falls back to a generic
                  // label if dual-write partial failure (000124) lost
                  // the event row, so the pill never reads broken.
                  const overrideActorName = isOverride
                    ? (auditEvent?.event_type === 'designer_override_approve'
                        ? auditEvent.actor_name
                        : 'designer')
                    : null
                  return (
                    <div
                      key={key}
                      className={['px-5 py-3', separator].join(' ')}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <p className="text-sm font-semibold text-ink">{heading}</p>
                        {!approval && (
                          <span className="text-xs font-medium text-ink-mute">Pending</span>
                        )}
                        {approval?.state === 'approved' && (
                          <span className="inline-flex items-center gap-2 text-xs font-medium text-in-stock">
                            <span className="inline-block h-2 w-2 rounded-full bg-in-stock" aria-hidden="true" />
                            {isOverride ? (
                              <>
                                Approved in {vRef}, {when} by {overrideActorName}
                                <span className="font-normal text-ink-mute">
                                  — originally requested changes by {approval.actor_name}
                                </span>
                              </>
                            ) : (
                              <>Approved in {vRef}, {when} by {approval.actor_name}</>
                            )}
                            {/* Carry-forward provenance pill
                                (migration 000083). Only renders
                                when the approval is a carry-
                                forward row AND still approved AND
                                the source version still exists.
                                FK ON DELETE SET NULL drops the
                                pointer silently if the source
                                version is deleted — in that case
                                versionNumberById returns undefined
                                and the pill hides. Stays hidden
                                for changes_requested (even if the
                                row was originally a carry) per
                                the "honoured" semantics — the
                                pill reads as "still carried and
                                still valid". */}
                            {(() => {
                              const src = approval.carried_from_version_id
                              if (!src) return null
                              const srcNum = versionNumberById.get(src)
                              if (srcNum == null) return null
                              return (
                                <span className="rounded-full bg-canvas px-2 py-0.5 text-xs font-normal text-ink-mute">
                                  Carried from v{srcNum}
                                </span>
                              )
                            })()}
                          </span>
                        )}
                        {approval?.state === 'changes_requested' && (
                          <span className="inline-flex items-center gap-2 text-xs font-medium text-low">
                            <span className="inline-block h-2 w-2 rounded-full bg-low" aria-hidden="true" />
                            {auditEvent?.variant_display_name ? (
                              // Variant-round selection (000139). The
                              // customer "Choose this direction" surface
                              // routes through request_changes server-
                              // side, so the approval row reads
                              // 'changes_requested' — but the load-
                              // bearing detail for the designer is
                              // which direction was picked. Surface
                              // the variant name as the lead, with
                              // the actor + timing as secondary.
                              <>
                                Direction selected:{' '}
                                <strong className="font-semibold">
                                  {auditEvent.variant_display_name}
                                </strong>
                                {' '}in {vRef}, {when} by {approval.actor_name}
                              </>
                            ) : (
                              <>
                                Changes requested in {vRef}
                                {/* Phase 3 (000196) — quiet side
                                    indicator so the designer can
                                    see at-a-glance which face the
                                    customer was zoomed in on. The
                                    audit panel's Side row carries
                                    the same value for non-summary
                                    surfaces. */}
                                {auditEvent?.side && (
                                  <span className="font-normal text-low">
                                    {' '}({auditEvent.side === 'front' ? 'front' : 'back'})
                                  </span>
                                )}
                                , {when} by {approval.actor_name}
                              </>
                            )}
                          </span>
                        )}
                      </div>
                      {/* Customer's change_request body. Surfaces
                          both for active changes_requested rows AND
                          for override rows where state has flipped
                          to 'approved' but the customer's original
                          feedback is preserved on the row. */}
                      {(approval?.state === 'changes_requested' || isOverride) && approval?.change_request && (
                        <p className="mt-1 text-xs text-ink-mute">{approval.change_request}</p>
                      )}
                      {/* Phase 2 Prompt 8 — audit detail toggle.
                          Renders only when there's a matching
                          proof_events row (customer-recorded
                          action). Designer-only approvals from
                          the modal don't have an event row and
                          skip the affordance entirely. */}
                      {auditEvent && auditKey && (
                        <div className="mt-2">
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedAuditKey((prev) => (prev === auditKey ? null : auditKey))
                            }
                            className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-mute hover:text-ink"
                          >
                            {expanded ? 'Hide details' : 'View details'}
                            {hsFailed && (
                              <span
                                title="Help Scout notification failed — customer was asked to email."
                                aria-label="Help Scout notification failed"
                                className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-low-soft text-[10px] font-bold text-low"
                              >
                                !
                              </span>
                            )}
                          </button>
                          {expanded && (
                            <AuditPanel event={auditEvent} hsFailed={hsFailed} />
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          )
        })()}

        {/* Versions panel — PanelShell with icon + count + eyebrow per
            the handoff brief. Body is a stack of version cards; each
            card is clickable and opens the existing VersionDetailModal
            for the heavy-action surface (Edit, Delete, Make current,
            full pricing view). The dashboard-style columnar layout +
            inline action buttons can land in a follow-up if needed —
            this PR is the chrome + visual rhythm pass. */}
        {versions.length === 0 ? (
          <div className="rounded-[14px] bg-surface py-16 text-center border border-line">
            <p className="text-ink-mute">No versions yet.</p>
            {!isApproved && (
              <Link
                to={`/proofs/${proof.id}/versions/new`}
                className="mt-3 inline-block text-[14px] font-medium text-ink underline"
              >
                Add the first version
              </Link>
            )}
          </div>
        ) : (
          <PanelShell
            title="Versions"
            count={versions.length}
            icon={Layers}
            accent={tokens.ink}
            eyebrow="Newest first"
            padded={false}
            action={
              !isLocked && (
                <ButtonGhost
                  size="sm"
                  icon={Plus}
                  onClick={() => navigate(`/proofs/${proof.id}/versions/new`)}
                >
                  New version
                </ButtonGhost>
              )
            }
          >
            {/* Stack of version cards. divide-y rather than per-card
                border keeps the visual mass within the panel rather
                than fragmenting it into 5 separate cards. */}
            <ul className="divide-y divide-line-soft">
              {versions.map((v) => {
                const viewsForThis = viewsByVersion.get(v.id) ?? []
                const hasReal = viewsForThis.length > 0
                let rowState: ViewedState
                if (v.is_current) {
                  const viewedSet = new Set<string>()
                  for (const [id, list] of viewsByVersion) {
                    if (list.length > 0) viewedSet.add(id)
                  }
                  rowState = computeViewedState({ currentVersionId: v.id, viewedVersionIds: viewedSet })
                } else {
                  rowState = hasReal ? 'viewed_current' : 'unviewed'
                }
                const latest = viewsForThis[0]?.viewed_at ?? null
                const thumb = versionThumbs.get(v.id)
                // Per-version pill mapping. Current + approved
                // proof → "Approved" (in-stock); current + active
                // → "In review" (allocated); current + dormant →
                // "Dormant" (muted). Non-current → "Archived"
                // (muted) — old versions are always archived from
                // the customer's POV.
                const versionPillLabel = !v.is_current
                  ? 'Archived'
                  : isApproved
                    ? 'Approved'
                    : isAbandoned
                      ? 'Abandoned'
                      : isDormant
                        ? 'Dormant'
                        : 'In review'
                const versionPillStyle = !v.is_current || isAbandoned || isDormant
                  ? { color: 'var(--c-ink-mute)', backgroundColor: 'var(--c-line-soft)' }
                  : isApproved
                    ? { color: 'var(--c-in-stock)', backgroundColor: 'var(--c-in-stock-soft)' }
                    : { color: 'var(--c-allocated)', backgroundColor: 'var(--c-allocated-soft)' }
                return (
                  <li
                    key={v.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open version ${v.version_number}`}
                    onClick={() => setSelectedVersion(v)}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter' || ev.key === ' ') {
                        ev.preventDefault()
                        setSelectedVersion(v)
                      }
                    }}
                    className="flex cursor-pointer gap-4 px-5 py-4 transition-colors hover:bg-canvas focus:outline-none focus-visible:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--c-brand)]"
                  >
                    {/* Thumbnail — 120×72 with the same dark-plate
                        placeholder fallback the dashboard rows use
                        when no signed URL has resolved yet. */}
                    <div
                      aria-hidden="true"
                      className="shrink-0 w-[120px] h-[72px] rounded-[6px] bg-ink overflow-hidden"
                    >
                      {thumb ? (
                        <img
                          src={thumb}
                          alt=""
                          loading="lazy"
                          className="w-full h-full object-cover"
                        />
                      ) : null}
                    </div>
                    {/* Right cluster: v# row + material/inks + change notes. */}
                    <div className="min-w-0 flex-1 flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[15px] font-semibold text-ink">v{v.version_number}</span>
                        <span className="text-[12px] text-ink-mute">
                          {new Date(v.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                        </span>
                        <span
                          className="pill"
                          style={versionPillStyle}
                          title={`${versionPillLabel}${latest ? ` · last viewed ${relativeTime(latest)}` : ''}`}
                        >
                          {versionPillLabel}
                        </span>
                        {v.custom_quote && (
                          <span
                            className="pill"
                            style={{ color: 'var(--c-ink-mute)', backgroundColor: 'var(--c-line-soft)' }}
                          >
                            Custom quote
                          </span>
                        )}
                        {/* A customer approval on a non-current
                            version is otherwise invisible here (the
                            row just reads "Archived"). Flag it so the
                            stranded sign-off is spottable at a glance. */}
                        {!v.is_current &&
                          approvals.some(
                            (a) => a.proof_version_id === v.id && a.state === 'approved',
                          ) && (
                            <span
                              className="pill"
                              style={{ color: 'var(--c-in-stock)', backgroundColor: 'var(--c-in-stock-soft)' }}
                            >
                              Customer approved
                            </span>
                          )}
                        {/* View-state dot — preserves the existing
                            three-state semantic at a glance. */}
                        <span
                          aria-label={viewedStateTitle(rowState)}
                          title={v.is_current ? viewedStateTitle(rowState) : (hasReal ? 'Viewed' : 'Not viewed')}
                          className={['inline-block h-2 w-2 shrink-0 rounded-full ml-auto', viewedStateDotClass(rowState)].join(' ')}
                        />
                      </div>
                      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[13px]">
                        <span className="text-ink-soft truncate" title={v.material_display}>
                          {v.material_display}
                        </span>
                        {v.currency && (
                          <span className="eyebrow text-ink-mute">{v.currency}</span>
                        )}
                        {v.ink_names.length > 0 && (
                          <span className="text-ink-mute text-[12px] truncate" title={v.ink_names.join(' · ')}>
                            {v.ink_names.join(' · ')}
                          </span>
                        )}
                      </div>
                      {v.change_notes && (
                        <p className="text-[13px] text-ink-soft leading-[1.55] line-clamp-2">
                          {v.change_notes}
                        </p>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          </PanelShell>
        )}

        {/* Approved artwork — production handoff bundle. Gated on
            the same isApproved flag that powers the header badge;
            renders between Versions and Delete so it sits in the
            natural "what next" flow after approval. Table mirrors
            the CustomerProofPage side-suppression rule (no Back
            images anywhere = one-sided project = drop the Side
            column) to avoid empty dashes. ZIP click regenerates
            from current state each time, no caching. */}
        {isApproved && approvedImages && (() => {
          const rows = approvedImages
          const currentVersion = versions.find((v) => v.is_current)
          const nameOrder = new Map<string, number>()
          currentVersion?.names.forEach((n, i) => nameOrder.set(n, i))
          const isOneSided = !rows.some((r) => r.side === 'back')
          // Every approved image is Shared (associated_name IS
          // NULL). Triggers column suppression in the UI table +
          // manifest, and root-level placement in the ZIP —
          // nothing to fold under a one-repeating-value column.
          // Same parity rule as isOneSided.
          const isAllShared = rows.length > 0 && rows.every((r) => r.associatedName == null)
          // Column-label copy: "Name" for business (recipient
          // people), "Variant" for membership with ≥1 variants
          // (tier labels). When isAllShared triggers the column
          // is suppressed entirely so the label is moot in that
          // case. Read card_type from the current version — in
          // practice every version in a project shares one mode.
          const identityColumnLabel =
            currentVersion?.card_type === 'membership' ? 'Variant' : 'Name'
          const sorted = [...rows].sort((a, b) => {
            const aShared = a.associatedName == null ? 0 : 1
            const bShared = b.associatedName == null ? 0 : 1
            if (aShared !== bShared) return aShared - bShared
            const aPos = a.associatedName == null ? -1 : nameOrder.get(a.associatedName) ?? Infinity
            const bPos = b.associatedName == null ? -1 : nameOrder.get(b.associatedName) ?? Infinity
            if (aPos !== bPos) return aPos - bPos
            const aSide = (a.side ?? 'front') === 'front' ? 0 : 1
            const bSide = (b.side ?? 'front') === 'front' ? 0 : 1
            if (aSide !== bSide) return aSide - bSide
            return a.imageId < b.imageId ? -1 : 1
          })
          return (
            <section>
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-widest text-ink-dim">Approved artwork</h2>
              <p className="mb-4 text-xs text-ink-mute">
                These filenames match the source Illustrator files — do not rename.
              </p>
              {sorted.length === 0 ? (
                <div className="rounded-2xl bg-surface py-10 text-center shadow-sm ring-1 ring-line">
                  <p className="text-sm text-ink-dim">No approved images found.</p>
                </div>
              ) : (
                <>
                  <div className="overflow-x-auto rounded-2xl bg-surface shadow-sm ring-1 ring-line">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-line-soft">
                          {!isAllShared && (
                            <th className="w-36 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-ink-dim">{identityColumnLabel}</th>
                          )}
                          {!isOneSided && (
                            <th className="w-24 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-ink-dim">Side</th>
                          )}
                          <th className="w-24 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-ink-dim">Version</th>
                          <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-ink-dim">Filename</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sorted.map((row) => {
                          const nameCol = row.associatedName ?? 'Shared'
                          const sideCol = (row.side ?? 'front') === 'front' ? 'Front' : 'Back'
                          const fileLabel = row.originalFilename ?? (
                            <span className="italic text-ink-dim">— (no filename captured)</span>
                          )
                          return (
                            <tr key={row.imageId} className="border-b border-line-soft last:border-0">
                              {!isAllShared && (
                                <td className="px-4 py-3 font-medium text-ink">{nameCol}</td>
                              )}
                              {!isOneSided && (
                                <td className="px-4 py-3 text-ink-mute">{sideCol}</td>
                              )}
                              <td className="px-4 py-3 text-ink-mute">v{row.versionNumber}</td>
                              <td className="px-4 py-3 text-ink-soft">{fileLabel}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-4">
                    <button
                      type="button"
                      onClick={handleDownloadZip}
                      disabled={zipPreparing}
                      className={[
                        'inline-flex items-center gap-2 rounded px-4 py-2 text-sm font-semibold text-on-ink transition-colors',
                        zipPreparing ? 'bg-ink/60' : 'bg-ink hover:opacity-90',
                        'disabled:cursor-not-allowed disabled:opacity-60',
                      ].join(' ')}
                    >
                      {zipPreparing && (
                        <span
                          aria-hidden="true"
                          className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-on-ink/40 border-t-white"
                        />
                      )}
                      {zipPreparing ? 'Preparing ZIP…' : 'Download all as ZIP'}
                    </button>
                  </div>
                </>
              )}
            </section>
          )
        })()}

          </div>

          {/* ── Meta rail — at-a-glance stats, key facts, internal
              notes, reply status, and the per-project history. Sticky
              alongside the main column on lg+; stacks underneath below
              that. The timeline is assembled client-side from data the
              page already loads (see buildTimelineEntries). */}
          <aside className="mt-8 space-y-6 lg:mt-0 lg:sticky lg:top-8">
            {statsPanel}
            {customerReplyPanel}
            {factsPanel}
            {internalNotesPanel}
            {timelinePanel}
          </aside>
        </div>

        {/* Danger zone — permanent delete, kept subtle to avoid accidental
            clicks. Available to any designer (migration 000243 relaxed the
            proofs DELETE policy from is_admin() back to authenticated), so
            a designer can bin a mistaken project without waiting for an
            admin. The confirm dialog below is the accident guard. */}
        <div className="mt-12 flex flex-col gap-3 border-t border-line-soft pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-ink-dim">
            Permanently remove this project and all its proof versions. Different from abandon, this cannot be undone.
          </p>
          <button
            onClick={() => { setDeleteError(null); setStatusDialog('delete') }}
            className="shrink-0 self-start rounded border border-out px-4 py-2 text-sm font-medium text-out hover:bg-out-soft sm:self-auto"
          >
            Delete project
          </button>
        </div>
      </div>

      {/* Change Help Scout conversation modal */}
      {showHelpscoutEdit && (
        <HelpScoutEditModal
          proofId={proof.id}
          proofLabel={proof.contacts?.full_name ?? proof.id}
          contactEmail={proof.contacts?.email ?? null}
          current={{
            conversationId: proof.helpscout_conversation_id,
            conversationUrl: proof.helpscout_conversation_url,
            overrideReason: proof.helpscout_override_reason,
          }}
          onSaved={() => {
            if (id) loadProof(id)
            showToast('Help Scout link updated.')
          }}
          onClose={() => setShowHelpscoutEdit(false)}
        />
      )}

      {/* Customer reply re-send modal. Hosts MessageSendPanel inside
          the same overlay-plus-card chrome as HelpScoutEditModal /
          ConfirmDialog. Only mounts when there's a current version
          to attribute the reply to AND a Help Scout conversation
          linked. The Customer reply section's gating already
          prevents the Send button from opening the modal in those
          cases, but the conditional here is defence in depth so a
          stray setShowReplyModal(true) can't render an empty modal. */}
      {showReplyModal && (() => {
        const currentVersion = versions.find((v) => v.is_current)
        if (!currentVersion) return null
        if (!proof.helpscout_conversation_id) return null
        const tplId: 'first_proof' | 'revision' =
          currentVersion.version_number === 1 ? 'first_proof' : 'revision'
        const customerUrl = `${window.location.origin}${customerProofPath(proof.id)}`
        const messageContext = {
          first_name: firstName(proof.contacts.full_name),
          full_name: proof.contacts.full_name,
          company: proof.contacts.companies?.name ?? null,
          version_number: currentVersion.version_number,
          url: customerUrl,
          designer_first_name: '',
        }
        return (
          <Modal
            open
            onClose={() => setShowReplyModal(false)}
            ariaLabel="Send customer reply"
            panelClassName="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-y-auto rounded-2xl bg-surface p-6 shadow-xl"
          >
                <MessageSendPanel
                  proofId={proof.id}
                  versionId={currentVersion.id}
                  versionNumber={currentVersion.version_number}
                  templateId={tplId}
                  context={messageContext}
                  hasHelpScoutConversation={true}
                  onSent={() => {
                    // Optimistically bump the version's
                    // last_reply_sent_at so the section's "Reply
                    // sent X ago" indicator flips immediately. The
                    // edge function's service-role write lands a
                    // moment later; loadProof picks up the
                    // canonical timestamp on refresh.
                    const nowIso = new Date().toISOString()
                    setVersions((prev) =>
                      prev.map((v) =>
                        v.id === currentVersion.id ? { ...v, last_reply_sent_at: nowIso } : v,
                      ),
                    )
                    setShowReplyModal(false)
                    if (id) loadProof(id)
                  }}
                  onSkip={() => setShowReplyModal(false)}
                  skipLabel="Cancel"
                />
          </Modal>
        )
      })()}

      {/* Re-send confirm dialog. Fires before opening the modal
          when there's a previous send for the current version, so
          a designer can't accidentally produce a duplicate reply
          in Help Scout from a casual button click. The first send
          on a version skips this and opens the editor directly. */}
      {showResendConfirm && (() => {
        const currentVersion = versions.find((v) => v.is_current)
        const lastSentIso = currentVersion?.last_reply_sent_at ?? null
        return (
          <ConfirmDialog
            message={`A reply was sent ${lastSentIso ? relativeTime(lastSentIso) : 'previously'}. Send another?`}
            confirmLabel="Send another"
            confirmClass="bg-ink hover:opacity-90 text-on-ink"
            working={false}
            onConfirm={() => {
              setShowResendConfirm(false)
              setShowReplyModal(true)
            }}
            onCancel={() => setShowResendConfirm(false)}
          />
        )
      })()}

      {/* Order builder (Ordering & checkout, Step 3). Prefilled from the
          current version; gated by isApproved + orderingEnabled at the
          button, so this only ever renders when ordering is on. */}
      {showOrderBuilder && (() => {
        const currentVersion = versions.find((v) => v.is_current)
        if (!currentVersion) return null
        return (
          <OrderBuilderModal
            proofId={proof.id}
            currentVersionId={currentVersion.id}
            materialId={currentVersion.material_id ?? null}
            displayedVariantIds={(currentVersion.displayed_variant_ids as string[] | null) ?? []}
            materialOptionCodes={(currentVersion.material_options as string[] | null) ?? []}
            customerLabel={proof.contacts.companies?.name ?? proof.contacts.full_name ?? null}
            materialDisplay={currentVersion.material_display ?? null}
            currency={(currentVersion.currency as 'GBP' | 'EUR' | 'USD' | null) ?? null}
            namesCount={currentVersion.names?.length ?? 0}
            hasPersonalisation={!!currentVersion.has_personalisation}
            isCustomQuote={!!currentVersion.custom_quote}
            hasHelpScoutConversation={!!proof.helpscout_conversation_id}
            onClose={() => setShowOrderBuilder(false)}
          />
        )
      })()}

      {/* Version detail modal */}
      {selectedVersion && (
        <VersionDetailModal
          version={selectedVersion}
          proofId={proof.id}
          proofLocked={isLocked}
          lockReason={isAbandoned ? 'abandoned' : isApproved ? 'approved' : null}
          allVersions={versions}
          viewHistory={viewsByVersion.get(selectedVersion.id) ?? []}
          contactFullName={proof.contacts.full_name}
          coreColours={coreColours}
          onClose={() => setSelectedVersion(null)}
          onApprovalsChanged={() => { if (id) loadProof(id) }}
          onVersionUpdated={handleVersionUpdated}
          onDeleteProofRequested={() => {
            setSelectedVersion(null)
            setDeleteError(null)
            setStatusDialog('delete')
          }}
        />
      )}

      {/* Approve confirm dialog */}
      {statusDialog === 'approve' && (
        <ConfirmDialog
          message={approveMessage}
          confirmLabel="Mark as approved"
          confirmClass={approveConfirmClass}
          working={statusWorking}
          onConfirm={guardStatusAction(handleApprove)}
          onCancel={() => setStatusDialog(null)}
        />
      )}

      {/* Abandon confirm dialog */}
      {statusDialog === 'abandon' && (
        <ConfirmDialog
          message="Abandon this project? This will lock the project. No new proof versions can be added, and the customer-facing page will show a closed state. You can reopen the project later if needed."
          confirmLabel="Abandon project"
          confirmClass="bg-ink hover:opacity-90 text-on-ink"
          working={statusWorking}
          onConfirm={guardStatusAction(handleAbandon)}
          onCancel={() => setStatusDialog(null)}
        />
      )}

      {/* Delete confirm dialog */}
      {statusDialog === 'delete' && (
        <ConfirmDialog
          message={`Permanently delete this project and all ${versions.length} proof version${versions.length === 1 ? '' : 's'}? This cannot be undone.`}
          confirmLabel="Delete project"
          confirmClass="bg-out hover:opacity-90 text-on-ink"
          working={statusWorking}
          errorMsg={deleteError}
          onConfirm={guardStatusAction(handleDelete)}
          onCancel={() => { setStatusDialog(null); setDeleteError(null) }}
        />
      )}

      {/* Reopen confirm dialog */}
      {statusDialog === 'reopen' && (
        <ConfirmDialog
          message={
            isAbandoned
              ? 'Reopen this project? This will reopen the project and allow new proof versions to be added.'
              : 'Reopen this project? It will go back to in progress and you\'ll be able to add new proof versions.'
          }
          confirmLabel="Reopen"
          confirmClass="bg-ink hover:opacity-90 text-on-ink"
          working={statusWorking}
          onConfirm={guardStatusAction(handleReopen)}
          onCancel={() => setStatusDialog(null)}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-on-ink shadow-lg">
          {toast}
        </div>
      )}
    </div>
    </DesignerChrome>
  )
}

// Overflow ("⋯") menu for the header's terminal state actions
// (Mark as approved / Abandon, or Reopen when locked). Keeps those
// rare, weighty actions out of the everyday action row. The dropdown
// is portalled to document.body and positioned from the trigger's
// rect because the header card uses overflow-hidden (for its rounded
// left status cap), which would otherwise clip an in-card dropdown.
type HeaderMenuItem = {
  label: string
  onClick: () => void
  tone?: 'default' | 'approve' | 'danger'
}

function HeaderActionsMenu({ items }: { items: HeaderMenuItem[] }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)

  useEffect(() => {
    if (!open) return
    function place() {
      const r = btnRef.current?.getBoundingClientRect()
      if (r) setPos({ top: r.bottom + 6, right: window.innerWidth - r.right })
    }
    place()
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (items.length === 0) return null

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-[38px] w-[38px] items-center justify-center rounded-[4px] border border-line bg-surface text-ink-soft transition-colors hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-brand)]"
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      {open && pos && createPortal(
        <>
          {/* Transparent click-catcher closes the menu on any outside click. */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="menu"
            className="fixed z-50 min-w-[180px] rounded-[8px] border border-line bg-surface py-1 shadow-md"
            style={{ top: pos.top, right: pos.right }}
          >
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                onClick={() => { setOpen(false); item.onClick() }}
                className={[
                  'block w-full px-3 py-2 text-left text-sm transition-colors hover:bg-canvas',
                  item.tone === 'danger' ? 'text-out' : item.tone === 'approve' ? 'text-in-stock' : 'text-ink-soft',
                ].join(' ')}
              >
                {item.label}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </>
  )
}

// Phase 2 Prompt 8 — audit detail panel for the Names rollup.
// Surfaces the customer-recorded event behind the approval state:
// who acted, when, the comment they left, the Help Scout thread
// link, and an inline IP/UA reveal toggle. Hidden by default so
// the rollup stays compact.
function AuditPanel({
  event,
  hsFailed,
}: {
  event: ProofEventAuditDetail
  hsFailed: boolean
}) {
  const [showAudit, setShowAudit] = useState(false)
  const ts = new Date(event.created_at)
  const tsLabel = Number.isNaN(ts.getTime())
    ? event.created_at
    : `${ts.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} at ${ts.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}`
  return (
    <div className="mt-3 rounded-lg bg-canvas px-3 py-3 text-xs ring-1 ring-line">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-ink-soft">
        <dt className="font-semibold text-ink-soft">Actor</dt>
        <dd className="text-ink">{event.actor_name}</dd>
        <dt className="font-semibold text-ink-soft">Recorded</dt>
        <dd className="text-ink">{tsLabel}</dd>
        {event.comment && (
          <>
            <dt className="font-semibold text-ink-soft">Comment</dt>
            <dd className="whitespace-pre-line text-ink">{event.comment}</dd>
          </>
        )}
        {/* Phase 3 (000196): which card face the customer had open
            in the detail view when they submitted. Rendered only
            when the column is non-null — events from before the
            Phase 3 rework, and events submitted with the detail
            view closed, simply omit the row. */}
        {event.side && (
          <>
            <dt className="font-semibold text-ink-soft">Side</dt>
            <dd className="text-ink">{event.side === 'front' ? 'Front' : 'Back'}</dd>
          </>
        )}
        {event.event_type === 'designer_override_approve' ? (
          <>
            <dt className="font-semibold text-ink-soft">Notification</dt>
            <dd className="text-ink-mute">
              <span className="text-[11px]">n/a — designer override (no customer notification)</span>
            </dd>
          </>
        ) : (
          <>
            <dt className="font-semibold text-ink-soft">Help Scout</dt>
            <dd>
              {event.helpscout_thread_id ? (
                <span className="text-ink">Thread {event.helpscout_thread_id}</span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-low">
                  <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-low-soft text-[10px] font-bold">!</span>
                  Notification failed — customer was asked to email
                </span>
              )}
              {!hsFailed && event.helpscout_thread_id && (
                <span className="ml-2 text-[11px] text-ink-dim">(thread id, no public link)</span>
              )}
            </dd>
          </>
        )}
      </dl>
      <div className="mt-2 border-t border-line pt-2">
        <button
          type="button"
          onClick={() => setShowAudit((v) => !v)}
          className="text-[11px] font-medium uppercase tracking-wider text-ink-dim hover:text-ink-soft"
        >
          {showAudit ? 'Hide audit (IP / UA)' : 'View audit (IP / UA)'}
        </button>
        {showAudit && (
          <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-ink-mute">
            <dt>IP</dt>
            <dd className="font-mono text-[11px] text-ink-soft">{event.from_ip ?? '—'}</dd>
            <dt>User-agent</dt>
            <dd className="break-all font-mono text-[11px] text-ink-soft">{event.from_ua ?? '—'}</dd>
          </dl>
        )}
      </div>
    </div>
  )
}

// Phase 4 (migration 000194) — read-only display of the hosted-vCard
// snapshot captured at approval time. Hosted-vCard QRs point at a
// vCard whose contact data stays editable indefinitely, so the live
// data can drift from what the customer approved. This panel surfaces
// what was frozen at the moment of approval so the designer can match
// it against the live vCard (or against a print proof) later.
//
// Read-only, designer-side, audit grid shape mirroring AuditPanel.
// One <dl> per snapshotted slug; when only one slug is present we
// drop the slug heading to keep the chrome quiet. Empty fields are
// elided rather than rendered as em-dashes — this is permanent audit
// data, not a form, and a missing line reads as "wasn't captured /
// was empty at the time", which is the honest signal.
function VcardSnapshotPanel({ snapshot }: { snapshot: QrSnapshot }) {
  const entries = Object.entries(snapshot)
  if (entries.length === 0) return null
  const showHeading = entries.length > 1
  return (
    <div className="mt-3 rounded-lg bg-canvas px-3 py-3 text-xs ring-1 ring-line">
      <div className="space-y-3">
        {entries.map(([slug, entry]) => (
          <VcardSnapshotEntryView
            key={slug}
            slug={slug}
            entry={entry}
            showHeading={showHeading}
          />
        ))}
      </div>
    </div>
  )
}

function VcardSnapshotEntryView({
  slug,
  entry,
  showHeading,
}: {
  slug: string
  entry: QrSnapshotEntry
  showHeading: boolean
}) {
  const capturedDate = (() => {
    const d = new Date(entry.captured_at)
    if (Number.isNaN(d.getTime())) return entry.captured_at
    return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} at ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}`
  })()

  // URL-redirect cards: the QR resolves to external_url, not to a
  // contact panel, so the only meaningful audit line is the
  // destination. Skip the contact field grid entirely. Treat null
  // target_type (legacy / forward-compat) as 'vcard'.
  if (entry.target_type === 'external_url') {
    return (
      <div>
        {showHeading && (
          <p className="mb-1 text-[11px] font-semibold text-ink-soft">
            qcrd.uk/{slug}
          </p>
        )}
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-ink-soft">
          <dt className="font-semibold text-ink-soft">Type</dt>
          <dd className="text-ink">URL redirect</dd>
          <dt className="font-semibold text-ink-soft">Redirects to</dt>
          <dd className="break-all font-mono text-ink">
            {entry.external_url ?? '(no destination recorded)'}
          </dd>
          <dt className="font-semibold text-ink-soft">Captured</dt>
          <dd className="text-ink-mute">{capturedDate}</dd>
        </dl>
      </div>
    )
  }

  const formattedName =
    [entry.first_name, entry.last_name].filter(Boolean).join(' ').trim() ||
    entry.nickname ||
    null
  const titleLine = [entry.job_title, entry.company].filter(Boolean).join(' · ')
  const addressLine = [
    entry.address_street,
    entry.address_city,
    entry.address_region,
    entry.address_postcode,
    entry.address_country,
  ]
    .map((p) => (p ?? '').trim())
    .filter(Boolean)
    .join(', ')
  const extraEmails = entry.contact_methods.filter((m) => m.method_type === 'email')
  const extraPhones = entry.contact_methods.filter((m) => m.method_type === 'phone')
  const sortedLinks = entry.links.slice().sort((a, b) => a.sort_order - b.sort_order)
  return (
    <div>
      {showHeading && (
        <p className="mb-1 text-[11px] font-semibold text-ink-soft">
          qcrd.uk/{slug}
        </p>
      )}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-ink-soft">
        {formattedName && (
          <>
            <dt className="font-semibold text-ink-soft">Name</dt>
            <dd className="text-ink">{formattedName}</dd>
          </>
        )}
        {entry.nickname && entry.nickname !== formattedName && (
          <>
            <dt className="font-semibold text-ink-soft">Nickname</dt>
            <dd className="text-ink">{entry.nickname}</dd>
          </>
        )}
        {titleLine && (
          <>
            <dt className="font-semibold text-ink-soft">Role</dt>
            <dd className="text-ink">{titleLine}</dd>
          </>
        )}
        {entry.primary_phone && (
          <>
            <dt className="font-semibold text-ink-soft">Phone</dt>
            <dd className="text-ink">
              <div className="font-mono">
                {entry.primary_phone}
                {entry.phone_label && (
                  <span className="ml-2 text-[10px] uppercase tracking-wider text-ink-mute">
                    {entry.phone_label}
                  </span>
                )}
              </div>
              {extraPhones.map((p) => (
                <div key={`${p.value}-${p.sort_order}`} className="font-mono">
                  {p.value}
                  {p.label && (
                    <span className="ml-2 text-[10px] uppercase tracking-wider text-ink-mute">
                      {p.label}
                    </span>
                  )}
                </div>
              ))}
            </dd>
          </>
        )}
        {entry.primary_email && (
          <>
            <dt className="font-semibold text-ink-soft">Email</dt>
            <dd className="text-ink">
              <div className="font-mono">
                {entry.primary_email}
                {entry.email_label && (
                  <span className="ml-2 text-[10px] uppercase tracking-wider text-ink-mute">
                    {entry.email_label}
                  </span>
                )}
              </div>
              {extraEmails.map((m) => (
                <div key={`${m.value}-${m.sort_order}`} className="font-mono">
                  {m.value}
                  {m.label && (
                    <span className="ml-2 text-[10px] uppercase tracking-wider text-ink-mute">
                      {m.label}
                    </span>
                  )}
                </div>
              ))}
            </dd>
          </>
        )}
        {addressLine && (
          <>
            <dt className="font-semibold text-ink-soft">Address</dt>
            <dd className="text-ink">{addressLine}</dd>
          </>
        )}
        {entry.birthday && (
          <>
            <dt className="font-semibold text-ink-soft">Birthday</dt>
            <dd className="font-mono text-ink">{entry.birthday}</dd>
          </>
        )}
        {entry.bio && (
          <>
            <dt className="font-semibold text-ink-soft">Bio</dt>
            <dd className="whitespace-pre-line text-ink">{entry.bio}</dd>
          </>
        )}
        {sortedLinks.length > 0 && (
          <>
            <dt className="font-semibold text-ink-soft">Links</dt>
            <dd className="text-ink">
              {sortedLinks.map((l) => (
                <div key={l.url + l.sort_order} className="break-all font-mono">
                  {l.label ? `${l.label} — ` : ''}
                  {l.url}
                </div>
              ))}
            </dd>
          </>
        )}
        <dt className="font-semibold text-ink-soft">Captured</dt>
        <dd className="text-ink-mute">{capturedDate}</dd>
      </dl>
    </div>
  )
}

// Module-level counter so each ConfirmDialog instance gets a stable
// unique id for the message paragraph (drives aria-describedby on
// the panel). Counter is fine since ConfirmDialogs are short-lived
// and there's at most one open at a time on this page.
let confirmDialogIdCounter = 0

function ConfirmDialog({
  message,
  confirmLabel,
  confirmClass,
  working,
  errorMsg,
  onConfirm,
  onCancel,
}: {
  message: string
  confirmLabel: string
  confirmClass: string
  working: boolean
  errorMsg?: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  // useState seed runs once per mount — gives a stable id for the
  // lifetime of this particular dialog without depending on the
  // global counter changing between renders.
  const [messageId] = useState(() => `confirm-dialog-msg-${++confirmDialogIdCounter}`)
  return (
    <Modal
      open
      onClose={onCancel}
      preventClose={working}
      ariaLabel="Confirm action"
      ariaDescribedBy={messageId}
      panelClassName="w-full max-w-sm rounded-2xl bg-surface p-6 shadow-xl"
    >
      <p id={messageId} className="text-sm text-ink-soft">{message}</p>
      {errorMsg && (
        <p className="mt-3 rounded-lg bg-out-soft px-3 py-2 text-xs text-out">{errorMsg}</p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <button
          onClick={onCancel}
          disabled={working}
          className="rounded px-4 py-2 text-sm font-medium text-ink-mute hover:bg-canvas disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={working}
          className={`rounded px-4 py-2 text-sm font-semibold disabled:opacity-50 ${confirmClass}`}
        >
          {working ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
