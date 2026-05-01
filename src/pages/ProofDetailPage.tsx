import { useEffect, useState, useRef } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import JSZip from 'jszip'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import VersionDetailModal, { type ModalVersion } from '../components/VersionDetailModal'
import HelpScoutEditModal from '../components/HelpScoutEditModal'
import MessageSendPanel from '../components/MessageSendPanel'
import { firstName } from '../lib/firstName'
import { getRepliesEnabled } from '../lib/repliesEnabled'
import { logAudit } from '../lib/audit'
import { relativeTime, formatAbsoluteDateTime } from '../lib/relativeTime'
import type { ProofNameApproval } from '../lib/types'
import { SHARED_APPROVAL_KEY } from '../lib/types'
import { deriveSharedApprovalState, type SharedApprovalState } from '../lib/sharedApproval'
import { useLiveProofViews } from '../lib/useLiveProofViews'
import { downloadBlob } from '../lib/downloadFile'
import { customerProofPath, designerPreviewPath } from '../lib/customerProofUrl'
import { QuoteLink } from '../components/QuoteLink'
import {
  computeViewedState,
  viewedStateDotClass,
  viewedStateTitle,
  type ViewedState,
} from '../lib/viewedState'

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
  const [versions, setVersions] = useState<ModalVersion[]>([])
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
  // Phase 2 Prompt 8 — proof_events audit detail for the Names
  // rollup. Loaded alongside approvals so each rollup row can
  // expand into the customer's own action detail (actor, comment,
  // timestamp, IP/UA, HS thread). Map keyed by `${versionId}|${name}`,
  // value is the chronologically-latest event for that pair.
  const [eventsByVersionAndName, setEventsByVersionAndName] = useState<
    Map<string, ProofEventAuditDetail>
  >(new Map())
  // Tracks which Names rollup row is expanded into the audit panel.
  // Single-string key ensures only one panel is open at a time.
  const [expandedAuditKey, setExpandedAuditKey] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [statusDialog, setStatusDialog] = useState<'approve' | 'reopen' | 'abandon' | 'delete' | null>(null)
  const [statusWorking, setStatusWorking] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [showHelpscoutEdit, setShowHelpscoutEdit] = useState(false)
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
        .select('id, version_number, material_id, material_display, ink_names, currency, is_current, created_at, change_notes, pricing_snapshot, shipping_note, custom_quote, names, card_type, last_reply_sent_at, displayed_variant_ids, materials(display_quantities)')
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
      const { data: eventRows } = await supabase
        .from('proof_events')
        .select('id, proof_version_id, name, event_type, actor_name, comment, from_ip, from_ua, helpscout_thread_id, created_at')
        .in('proof_version_id', versionIds)
        .order('created_at', { ascending: false })
      if (isStale()) return
      const map = new Map<string, ProofEventAuditDetail>()
      for (const r of (eventRows ?? []) as Array<
        ProofEventAuditDetail & { proof_version_id: string; name: string | null }
      >) {
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
          })
        }
      }
      setEventsByVersionAndName(map)
    } else {
      setEventsByVersionAndName(new Map())
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
            })
          } else if (existing.state === 'changes_requested') {
            overrides.push(existing)
          }
          // else: existing.state === 'approved' → no-op
        }

        // Apply override updates one row at a time. Volume is small
        // (one row per recipient with an open change-request) and
        // Supabase REST doesn't expose a multi-row update with
        // distinct values, so .update().eq('id', …) per row is the
        // cleanest path. Failing fast on the first error mirrors
        // the existing "any DB error aborts the flow" pattern.
        for (const row of overrides) {
          const { error: upErr } = await supabase
            .from('proof_name_approvals')
            .update({
              state: 'approved',
              overridden_from_state: 'changes_requested',
              overridden_by_user_id: designerUserId,
              overridden_at: now,
              updated_at: now,
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

        // proof_events row per overridden slot. Designer identity
        // goes on actor_name (the table requires text); recipient
        // name goes on `name`. material_option_code is null — an
        // override is whole-row, not option-tab-scoped, and 000124
        // documents null as the "not applicable" semantic.
        //
        // Dual-write tolerance: if proof_name_approvals is already
        // updated and this insert fails, the override audit is
        // partial — overridden_from_state is recorded on the row
        // but the activity feed has no entry. Surface the error
        // via toast without rolling back the approval; mirrors the
        // partial-failure pattern documented in 000124.
        if (overrides.length > 0) {
          const eventRows = overrides.map((o) => ({
            proof_version_id: currentVersion.id,
            event_type: 'designer_override_approve' as const,
            actor_name: designerName,
            name: o.name,
            comment: null,
            from_ip: null,
            from_ua: null,
            pricing_snapshot_at_action: null,
            material_option_code: null,
          }))
          const { error: evErr } = await supabase
            .from('proof_events')
            .insert(eventRows)
          if (evErr) {
            showToast(`Override recorded, but activity feed entry failed: ${evErr.message}`)
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
    // Clear both terminal timestamps so the same flow works for approved and abandoned.
    const { error } = await supabase
      .from('proofs')
      .update({ status: 'in_progress', approved_at: null, abandoned_at: null })
      .eq('id', proof.id)
    setStatusWorking(false)
    setStatusDialog(null)
    if (!error) {
      showToast('Project reopened')
      if (id) loadProof(id)
    }
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
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-gray-900" />
      </div>
    )
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
    ? 'bg-slate-700 hover:bg-slate-800 text-white'
    : 'bg-emerald-600 hover:bg-emerald-700 text-white'

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">

        {/* Back + Quote compiler. QuoteLink lives in the per-page
            header on six pages today (Dashboard, Admin, ProofDetail,
            NewProof, NewVersion, EditVersion). Future "extract shared
            header" pass should inline this once and remove the
            per-page insertions. */}
        <div className="mb-6 flex items-center justify-between">
          <Link to="/" className="text-sm text-gray-400 hover:text-gray-700">← Back to projects</Link>
          <QuoteLink variant="inline" />
        </div>

        {/* Proof header */}
        <div className="mb-8 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{proof.contacts.full_name}</h1>
            {proof.contacts.companies?.name && (
              <p className="mt-1 text-gray-500">{proof.contacts.companies.name}</p>
            )}
            <p className="mt-0.5 text-sm text-gray-400">{proof.contacts.email}</p>
            {/* Status badge */}
            <div className="mt-3">
              <div className="flex flex-wrap items-center gap-2">
                {isApproved ? (
                  <span className="inline-flex items-center rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
                    Approved{proof.approved_at ? ` on ${formatLongDate(proof.approved_at)}` : ''}
                  </span>
                ) : isAbandoned ? (
                  <span className="inline-flex items-center rounded-full bg-slate-200 px-3 py-1 text-xs font-semibold text-slate-700">
                    Abandoned{proof.abandoned_at ? ` on ${formatLongDate(proof.abandoned_at)}` : ''}
                  </span>
                ) : isDormant ? (
                  <span className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-500">
                    Dormant
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700">
                    In progress
                  </span>
                )}
                {currentIsCustomQuote && (
                  <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                    Custom quote
                  </span>
                )}
              </div>
              {isDormant && (
                <p className="mt-1.5 text-xs text-gray-400">No activity for 30+ days. Add a version to reactivate.</p>
              )}
              {/* Disclaimer acknowledgement subline (migration 000091).
                  Renders at any status once the customer ticks the
                  "I've read this and understand the terms" box on
                  the customer page. Copy deliberately echoes the
                  customer-facing label — "Terms" — so the designer
                  sees the same word the customer consented against.
                  HH:mm in 24h en-GB to match the rest of the app's
                  British formatting. */}
              {proof.disclaimer_acknowledged_at && (
                <p className="mt-1.5 text-xs text-gray-400">
                  Terms acknowledged on {formatLongDate(proof.disclaimer_acknowledged_at)} at{' '}
                  {new Date(proof.disclaimer_acknowledged_at).toLocaleTimeString('en-GB', {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                  })}
                </p>
              )}
            </div>
          </div>
          {/* Action cluster — two right-aligned rows.
              Row 1 (day-to-day workflow): Preview, Copy, Add version.
              Add version keeps its filled-black primary style and
              anchors the right edge of the row.
              Row 2 (terminal state): Abandon, Mark as approved.
              Mark as approved (positive) anchors the right edge;
              Abandon is placed to its left so the destructive
              control sits furthest from the primary Add version
              directly above.
              Locked variant (approved/abandoned): Add version is
              hidden on row 1, and row 2 collapses to a lone Reopen
              button in the same right-aligned slot. */}
          <div className="flex flex-col items-end gap-8">
            {/* Row 1 */}
            <div className="flex flex-wrap justify-end gap-2">
              {/* Preview is gated on there being at least one proof
                  version — otherwise the customer page renders
                  near-blank. Disabled rendering keeps the affordance
                  discoverable and teaches the unlock. */}
              <button
                type="button"
                onClick={() => {
                  // Open the customer page in a new tab rather than a
                  // same-origin iframe modal. The previous modal
                  // collapsed silently in some setups (parent HMR
                  // reconnect on dev, X-Frame-Options on certain
                  // deploys) and the external-link icon already
                  // promised a new-window experience. noopener +
                  // noreferrer so the customer-page tab can't reach
                  // back into window.opener.
                  window.open(designerPreviewPath(proof.id), '_blank', 'noopener,noreferrer')
                }}
                disabled={versions.length === 0}
                title={versions.length === 0 ? 'Add a version to enable preview' : undefined}
                className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-gray-500 ring-1 ring-gray-200 hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-400 disabled:ring-gray-100 disabled:hover:bg-transparent"
              >
                <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 3H3.5A1.5 1.5 0 002 4.5v8A1.5 1.5 0 003.5 14h8A1.5 1.5 0 0013 12.5V10M10 2h4m0 0v4m0-4L7 9" />
                </svg>
                Preview as customer
              </button>
              <button
                onClick={copyCustomerUrl}
                className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-gray-500 ring-1 ring-gray-200 hover:bg-gray-50"
              >
                {copied ? (
                  <>
                    <svg className="h-4 w-4 text-emerald-500" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l3.5 3.5 6.5-7" />
                    </svg>
                    <span className="text-emerald-600">Link copied</span>
                  </>
                ) : (
                  <>
                    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <rect x="5" y="5" width="8" height="8" rx="1.5" />
                      <path strokeLinecap="round" d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" />
                    </svg>
                    Copy customer URL
                  </>
                )}
              </button>
              {!isLocked && (
                <Link
                  to={`/proofs/${proof.id}/versions/new`}
                  className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700"
                >
                  Add version
                </Link>
              )}
            </div>

            {/* Hidden input for clipboard fallback. Sits outside the
                rows so it can't disturb the flex layout. */}
            <input ref={fallbackInputRef} className="sr-only" readOnly aria-hidden="true" />

            {/* Row 2 */}
            {isLocked ? (
              <div className="flex justify-end">
                <button
                  onClick={() => setStatusDialog('reopen')}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 ring-1 ring-gray-200 hover:bg-gray-50"
                >
                  Reopen
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  onClick={() => setStatusDialog('abandon')}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-rose-500 ring-1 ring-rose-200 hover:bg-rose-50"
                >
                  Abandon project
                </button>
                <button
                  onClick={() => setStatusDialog('approve')}
                  className="rounded-lg bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-100"
                >
                  Mark as approved
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Internal metadata. Always rendered so the Change Help
            Scout button is always reachable — even proofs with
            nothing recorded can have their link set from here. */}
        <div className="mb-8 rounded-2xl bg-amber-50 p-5 ring-1 ring-amber-100">
          <div className="flex items-start justify-between gap-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-amber-600">Internal</p>
            <button
              type="button"
              onClick={() => setShowHelpscoutEdit(true)}
              className="shrink-0 text-xs text-amber-700 underline hover:text-amber-900"
            >
              Change Help Scout conversation
            </button>
          </div>
          <div className="mt-2 space-y-1 text-sm">
            {proof.helpscout_conversation_url ? (
              <p>
                <span className="text-gray-500">Help Scout: </span>
                <a href={proof.helpscout_conversation_url} target="_blank" rel="noopener noreferrer"
                  className="text-amber-800 underline">
                  {proof.helpscout_conversation_url}
                </a>
              </p>
            ) : proof.helpscout_override_reason ? (
              <p className="text-amber-900">
                <span className="text-gray-500">Help Scout override: </span>
                <span className="italic">{proof.helpscout_override_reason}</span>
              </p>
            ) : proof.helpscout_thread_url ? (
              <p>
                <span className="text-gray-500">Help Scout (legacy): </span>
                <a href={proof.helpscout_thread_url} target="_blank" rel="noopener noreferrer"
                  className="text-amber-800 underline">
                  {proof.helpscout_thread_url}
                </a>
              </p>
            ) : (
              <p className="italic text-gray-500">No Help Scout conversation linked.</p>
            )}
            {proof.internal_notes && (
              <p className="text-amber-900">{proof.internal_notes}</p>
            )}
          </div>
        </div>

        {/* Customer reply (Ship 3 of intervention 3). Re-send
            affordance scoped to the current version. Shows whether a
            reply has gone out (denormalised proof_versions
            .last_reply_sent_at), and lets the designer trigger or
            re-trigger the editor without leaving the page. Hidden on
            locked projects (approved/abandoned) and projects with no
            versions; renders muted disabled-button copy when the
            proof has no Help Scout conversation linked yet. */}
        {(() => {
          const currentVersion = versions.find((v) => v.is_current)
          if (!currentVersion) return null
          if (isLocked) return null
          const hasHs = !!proof.helpscout_conversation_id
          const lastSentIso = currentVersion.last_reply_sent_at
          // Replies-paused state takes precedence over the
          // "Send/Send again" labelling: even when a previous send
          // exists, the button stays disabled while the global
          // flag is off so a designer doesn't trigger the confirm
          // dialog only to fail on send.
          const repliesPaused = repliesEnabled === false
          const pausedNote =
            role === 'admin'
              ? 'Replies are currently paused. Enable in Settings.'
              : 'Replies are currently paused.'
          return (
            <section className="mb-8 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-200">
              <div className="flex items-center gap-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">Customer reply</p>
              </div>
              {!hasHs ? (
                <div className="mt-2 flex items-start justify-between gap-4">
                  <p className="text-sm text-gray-500">
                    No Help Scout conversation linked. Add one in the Internal panel above to enable replies.
                  </p>
                  <button
                    type="button"
                    disabled
                    className="shrink-0 rounded-lg bg-gray-200 px-4 py-2 text-sm font-semibold text-gray-400 cursor-not-allowed"
                  >
                    Send reply
                  </button>
                </div>
              ) : lastSentIso ? (
                <div className="mt-2 flex items-center justify-between gap-4">
                  <p className="text-sm text-gray-700">
                    Reply sent{' '}
                    <span title={formatAbsoluteDateTime(lastSentIso)} className="font-medium text-gray-900">
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
                      'shrink-0 rounded-lg px-4 py-2 text-sm font-medium ring-1',
                      repliesPaused
                        ? 'bg-gray-100 text-gray-400 ring-gray-100 cursor-not-allowed'
                        : 'text-gray-600 ring-gray-200 hover:bg-gray-50',
                    ].join(' ')}
                  >
                    Send again
                  </button>
                </div>
              ) : (
                <div className="mt-2 flex items-center justify-between gap-4">
                  <p className="text-sm text-gray-500">
                    No reply sent yet for v{currentVersion.version_number}.
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowReplyModal(true)}
                    disabled={repliesPaused}
                    title={repliesPaused ? pausedNote : undefined}
                    className={[
                      'shrink-0 rounded-lg px-4 py-2 text-sm font-semibold',
                      repliesPaused
                        ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                        : 'bg-gray-900 text-white hover:bg-gray-700',
                    ].join(' ')}
                  >
                    Send reply
                  </button>
                </div>
              )}
              {repliesPaused && hasHs && (
                <p className="mt-2 text-xs text-amber-700">{pausedNote}</p>
              )}
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
            <section className="mb-8">
              <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-gray-400">Names</h2>
              <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
                {rollupEntries.map((entry, i) => {
                  const isSharedRow = entry.kind === 'shared'
                  // Row separator: a stronger border above Shared
                  // than between name rows, mirroring the modal's
                  // visual distinction between per-name cards and
                  // the Shared block.
                  const separator = i === 0
                    ? ''
                    : isSharedRow
                    ? 'border-t border-gray-200'
                    : 'border-t border-gray-100'

                  if (entry.kind === 'shared') {
                    // Derived row — no actor name, no carry pill, no
                    // audit toggle. Shared has no own approval event
                    // to expand; the per-name rows above already
                    // surface that detail.
                    const when = entry.derived.latestApprovedAt
                      ? new Date(entry.derived.latestApprovedAt).toLocaleDateString('en-GB')
                      : null
                    return (
                      <div key={entry.key} className={['px-5 py-3', separator].join(' ')}>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <p className="text-sm font-semibold text-gray-900">{entry.heading}</p>
                          {entry.derived.state === 'pending' && (
                            <span className="text-xs font-medium text-gray-500">Pending</span>
                          )}
                          {entry.derived.state === 'approved' && (
                            <span className="inline-flex items-center gap-2 text-xs font-medium text-emerald-800">
                              <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
                              Approved in v{entry.versionNumber}{when ? `, ${when}` : ''}
                            </span>
                          )}
                        </div>
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
                        <p className="text-sm font-semibold text-gray-900">{heading}</p>
                        {!approval && (
                          <span className="text-xs font-medium text-gray-500">Pending</span>
                        )}
                        {approval?.state === 'approved' && (
                          <span className="inline-flex items-center gap-2 text-xs font-medium text-emerald-800">
                            <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
                            {isOverride ? (
                              <>
                                Approved in {vRef}, {when} by {overrideActorName}
                                <span className="font-normal text-gray-500">
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
                                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-normal text-gray-500">
                                  Carried from v{srcNum}
                                </span>
                              )
                            })()}
                          </span>
                        )}
                        {approval?.state === 'changes_requested' && (
                          <span className="inline-flex items-center gap-2 text-xs font-medium text-amber-800">
                            <span className="inline-block h-2 w-2 rounded-full bg-amber-500" aria-hidden="true" />
                            Changes requested in {vRef}, {when} by {approval.actor_name}
                          </span>
                        )}
                      </div>
                      {/* Customer's change_request body. Surfaces
                          both for active changes_requested rows AND
                          for override rows where state has flipped
                          to 'approved' but the customer's original
                          feedback is preserved on the row. */}
                      {(approval?.state === 'changes_requested' || isOverride) && approval?.change_request && (
                        <p className="mt-1 text-xs text-gray-500">{approval.change_request}</p>
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
                            className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-gray-900"
                          >
                            {expanded ? 'Hide details' : 'View details'}
                            {hsFailed && (
                              <span
                                title="Help Scout notification failed — customer was asked to email."
                                aria-label="Help Scout notification failed"
                                className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-amber-100 text-[10px] font-bold text-amber-700"
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

        {/* Versions */}
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-gray-400">Versions</h2>

        {versions.length === 0 ? (
          <div className="rounded-2xl bg-white py-16 text-center shadow-sm ring-1 ring-gray-200">
            <p className="text-gray-400">No versions yet.</p>
            {!isApproved && (
              <Link to={`/proofs/${proof.id}/versions/new`}
                className="mt-3 inline-block text-sm font-medium text-gray-900 underline">
                Add the first version
              </Link>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
            <table className="w-full table-fixed text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="w-36 truncate px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Version</th>
                  <th className="w-36 truncate px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Material</th>
                  <th className="w-28 truncate px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Currency</th>
                  <th className="truncate px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Notes</th>
                  <th className="w-28 truncate px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Added</th>
                  <th className="w-40 truncate px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Status</th>
                  <th className="w-12 px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => {
                  const viewsForThis = viewsByVersion.get(v.id) ?? []
                  const hasReal = viewsForThis.length > 0
                  let rowState: ViewedState
                  if (v.is_current) {
                    // Current version: three-state based on whether
                    // any real view exists anywhere on the project
                    // and whether this specific version is viewed.
                    const viewedSet = new Set<string>()
                    for (const [id, list] of viewsByVersion) {
                      if (list.length > 0) viewedSet.add(id)
                    }
                    rowState = computeViewedState({ currentVersionId: v.id, viewedVersionIds: viewedSet })
                  } else {
                    // Older version: two-state. Green when the
                    // customer actually opened that specific
                    // version, grey when not.
                    rowState = hasReal ? 'viewed_current' : 'unviewed'
                  }
                  const latest = viewsForThis[0]?.viewed_at ?? null
                  return (
                  <tr
                    key={v.id}
                    onClick={() => setSelectedVersion(v)}
                    className="cursor-pointer border-b border-gray-50 last:border-0 hover:bg-gray-50"
                  >
                    <td className="truncate px-4 py-4 font-medium text-gray-900">
                      <span className="flex items-center gap-2">
                        <span
                          aria-label={viewedStateTitle(rowState)}
                          title={v.is_current ? viewedStateTitle(rowState) : (hasReal ? 'Viewed' : 'Not viewed')}
                          className={['inline-block h-2.5 w-2.5 shrink-0 rounded-full', viewedStateDotClass(rowState)].join(' ')}
                        />
                        <span>v{v.version_number}</span>
                        {latest && (
                          <span className="ml-1 text-xs font-normal text-gray-400" title={formatAbsoluteDateTime(latest)}>· {relativeTime(latest)}</span>
                        )}
                      </span>
                    </td>
                    <td className="truncate px-4 py-4 text-gray-700" title={v.material_display}>{v.material_display}</td>
                    <td className="truncate px-4 py-4 text-gray-500">{v.currency}</td>
                    <td className="truncate px-4 py-4 text-gray-500" title={v.change_notes ?? undefined}>{v.change_notes ?? '—'}</td>
                    <td className="truncate px-4 py-4 text-gray-500">
                      {new Date(v.created_at).toLocaleDateString('en-GB')}
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex flex-wrap gap-1">
                        {v.is_current && (
                          <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
                            Current
                          </span>
                        )}
                        {v.custom_quote && (
                          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600">
                            Custom quote
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <svg className="h-4 w-4 text-gray-300" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 3l5 5-5 5" />
                      </svg>
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
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
            <section className="mt-12">
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-widest text-gray-400">Approved artwork</h2>
              <p className="mb-4 text-xs text-gray-500">
                These filenames match the source Illustrator files — do not rename.
              </p>
              {sorted.length === 0 ? (
                <div className="rounded-2xl bg-white py-10 text-center shadow-sm ring-1 ring-gray-200">
                  <p className="text-sm text-gray-400">No approved images found.</p>
                </div>
              ) : (
                <>
                  <div className="overflow-x-auto rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-100">
                          {!isAllShared && (
                            <th className="w-36 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">{identityColumnLabel}</th>
                          )}
                          {!isOneSided && (
                            <th className="w-24 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Side</th>
                          )}
                          <th className="w-24 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Version</th>
                          <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Filename</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sorted.map((row) => {
                          const nameCol = row.associatedName ?? 'Shared'
                          const sideCol = (row.side ?? 'front') === 'front' ? 'Front' : 'Back'
                          const fileLabel = row.originalFilename ?? (
                            <span className="italic text-gray-400">— (no filename captured)</span>
                          )
                          return (
                            <tr key={row.imageId} className="border-b border-gray-50 last:border-0">
                              {!isAllShared && (
                                <td className="px-4 py-3 font-medium text-gray-900">{nameCol}</td>
                              )}
                              {!isOneSided && (
                                <td className="px-4 py-3 text-gray-500">{sideCol}</td>
                              )}
                              <td className="px-4 py-3 text-gray-500">v{row.versionNumber}</td>
                              <td className="px-4 py-3 text-gray-700">{fileLabel}</td>
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
                        'inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white transition-colors',
                        zipPreparing ? 'bg-gray-900/60' : 'bg-gray-900 hover:bg-gray-700',
                        'disabled:cursor-not-allowed disabled:opacity-60',
                      ].join(' ')}
                    >
                      {zipPreparing && (
                        <span
                          aria-hidden="true"
                          className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
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

        {/* Danger zone — permanent delete, kept subtle to avoid accidental
            clicks. Admin-only to match the DB gate (migration 000074),
            which restricts DELETE on proofs to is_admin(). A non-admin
            clicking here would get an RLS error — hiding the control is
            the clean frontend mirror of that. */}
        {role === 'admin' && (
          <div className="mt-12 flex flex-col gap-3 border-t border-gray-100 pt-6 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-gray-400">
              Permanently remove this project and all its proof versions. Different from abandon, this cannot be undone.
            </p>
            <button
              onClick={() => { setDeleteError(null); setStatusDialog('delete') }}
              className="shrink-0 self-start rounded-lg border border-rose-200 px-4 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 sm:self-auto"
            >
              Delete project
            </button>
          </div>
        )}
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
          <>
            <div
              className="fixed inset-0 z-40 bg-black/50"
              onClick={() => setShowReplyModal(false)}
            />
            <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8">
              <div className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-xl">
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
              </div>
            </div>
          </>
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
            confirmClass="bg-gray-900 hover:bg-gray-700 text-white"
            working={false}
            onConfirm={() => {
              setShowResendConfirm(false)
              setShowReplyModal(true)
            }}
            onCancel={() => setShowResendConfirm(false)}
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
          onConfirm={handleApprove}
          onCancel={() => setStatusDialog(null)}
        />
      )}

      {/* Abandon confirm dialog */}
      {statusDialog === 'abandon' && (
        <ConfirmDialog
          message="Abandon this project? This will lock the project. No new proof versions can be added, and the customer-facing page will show a closed state. You can reopen the project later if needed."
          confirmLabel="Abandon project"
          confirmClass="bg-slate-700 hover:bg-slate-800 text-white"
          working={statusWorking}
          onConfirm={handleAbandon}
          onCancel={() => setStatusDialog(null)}
        />
      )}

      {/* Delete confirm dialog */}
      {statusDialog === 'delete' && (
        <ConfirmDialog
          message={`Permanently delete this project and all ${versions.length} proof version${versions.length === 1 ? '' : 's'}? This cannot be undone.`}
          confirmLabel="Delete project"
          confirmClass="bg-rose-600 hover:bg-rose-700 text-white"
          working={statusWorking}
          errorMsg={deleteError}
          onConfirm={handleDelete}
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
          confirmClass="bg-gray-900 hover:bg-gray-700 text-white"
          working={statusWorking}
          onConfirm={handleReopen}
          onCancel={() => setStatusDialog(null)}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-gray-900 px-5 py-2.5 text-sm font-medium text-white shadow-lg">
          {toast}
        </div>
      )}
    </div>
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
    <div className="mt-3 rounded-lg bg-gray-50 px-3 py-3 text-xs ring-1 ring-gray-200">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-gray-600">
        <dt className="font-semibold text-gray-700">Actor</dt>
        <dd className="text-gray-900">{event.actor_name}</dd>
        <dt className="font-semibold text-gray-700">Recorded</dt>
        <dd className="text-gray-900">{tsLabel}</dd>
        {event.comment && (
          <>
            <dt className="font-semibold text-gray-700">Comment</dt>
            <dd className="whitespace-pre-line text-gray-900">{event.comment}</dd>
          </>
        )}
        {event.event_type === 'designer_override_approve' ? (
          <>
            <dt className="font-semibold text-gray-700">Notification</dt>
            <dd className="text-gray-500">
              <span className="text-[11px]">n/a — designer override (no customer notification)</span>
            </dd>
          </>
        ) : (
          <>
            <dt className="font-semibold text-gray-700">Help Scout</dt>
            <dd>
              {event.helpscout_thread_id ? (
                <span className="text-gray-900">Thread {event.helpscout_thread_id}</span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-amber-700">
                  <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-100 text-[10px] font-bold">!</span>
                  Notification failed — customer was asked to email
                </span>
              )}
              {!hsFailed && event.helpscout_thread_id && (
                <span className="ml-2 text-[11px] text-gray-400">(thread id, no public link)</span>
              )}
            </dd>
          </>
        )}
      </dl>
      <div className="mt-2 border-t border-gray-200 pt-2">
        <button
          type="button"
          onClick={() => setShowAudit((v) => !v)}
          className="text-[11px] font-medium uppercase tracking-wider text-gray-400 hover:text-gray-700"
        >
          {showAudit ? 'Hide audit (IP / UA)' : 'View audit (IP / UA)'}
        </button>
        {showAudit && (
          <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-gray-500">
            <dt>IP</dt>
            <dd className="font-mono text-[11px] text-gray-700">{event.from_ip ?? '—'}</dd>
            <dt>User-agent</dt>
            <dd className="break-all font-mono text-[11px] text-gray-700">{event.from_ua ?? '—'}</dd>
          </dl>
        )}
      </div>
    </div>
  )
}

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
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={() => !working && onCancel()} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
          <p className="text-sm text-gray-700">{message}</p>
          {errorMsg && (
            <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{errorMsg}</p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={onCancel}
              disabled={working}
              className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={working}
              className={`rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50 ${confirmClass}`}
            >
              {working ? 'Working…' : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
