// Designer preview gate. Slots between Save and Send on the new-
// version flow (and between Save and the project page on edit-
// version) so the designer can't fall into the habit of saving and
// firing the Help Scout reply without ever looking at what the
// customer is about to see. Before this gate existed, the temptation
// was "create the version, click Send, move on" — and the first
// person to spot a layout error was the customer.
//
// The original gate was one always-enabled click, and the habit
// simply moved up a level: designers clicked "Looks good" without
// scrolling, and a badly-cropped upload reached a customer anyway.
// The confirm button is now earned, not given:
//
// - Scroll: the button stays disabled until the designer has reached
//   the end of the proof at least once. The iframe is same-origin, so
//   the gate reads the preview's scroll position directly — no
//   customer-page cooperation needed.
// - Option tabs: when the version renders finish/species tabs, each
//   tab must have been on screen once. The customer page reports tab
//   activity over the postMessage bridge (lib/previewBridge.ts), and
//   the banner shows one chip per tab that ticks off as it's viewed.
//   Chips are also buttons — clicking one switches the preview to
//   that tab and scrolls to the artwork, so the checklist is the
//   fastest way to flick through the options rather than an obstacle.
//
// Deliberately NOT here: minimum-dwell timers (they punish fast-but-
// genuine reviews and get alt-tabbed around) and anything that
// re-locks once earned (requirements only ratchet — see
// lib/previewReview.ts, which owns the state rules and their tests).
// Everything fails open: if the bridge context never arrives (cached
// older customer-page bundle) the gate times out to scroll-only, and
// if scroll tracking throws, the scroll requirement is waived. A
// broken gate must never stop proofs going out.
//
// Confirm and edit-return both write an audit entry (preview seconds,
// scroll depth, tabs viewed) so a click-through habit is visible on
// Admin → Activity long before a customer catches the next mistake.
//
// Shape: a banner at the top with version label, currency, the two
// action buttons (confirm → onConfirm; Go back and edit → onEdit) and
// the checklist strip, plus an iframe filling the rest of the
// viewport pointing at /p/:id?preview=1&v=:versionId.
//
// Rendering the customer page inside an iframe (rather than importing
// the components directly) means the preview cannot drift from
// reality — same route, same data path (public_get_customer_proof
// RPC), same lightbox behaviour. The ?preview=1 flag suppresses
// view-recording on the customer side (see lib/customerProofUrl.ts)
// and, together with being framed, switches the page's preview-bridge
// reporting on. The ?v= param pins the iframe to the specific
// just-saved version, important because designers can edit
// non-current versions and the customer page defaults to whichever
// version carries is_current.
//
// State is deliberately ephemeral (callbacks only, no preview-
// approved column on proof_versions) — persisting would muddy the
// meaning when edits, reopens, or carry-forwards happen later. The
// audit ledger carries the durable record instead.

import { useEffect, useRef, useState } from 'react'
import { ArrowDown, Check, Eye, MessageSquare, ScanSearch } from 'lucide-react'
import { logAudit } from '../lib/audit'
import { customerProofPath } from '../lib/customerProofUrl'
import { asPreviewPageMessage, postShowTab } from '../lib/previewBridge'
import Modal from './Modal'
import ArtworkCheckReportView, { InlineSpinner, artworkCheckAuditFields, artworkVerdict } from './ArtworkCheckReportView'
import { useProofCheck } from '../lib/useProofCheck'
import { useCalloutsEnabled } from '../lib/useCalloutsEnabled'
import { ProofAnnotationEditor } from './ProofAnnotationEditor'
import { useAuth } from '../lib/auth'
import {
  initialProgress,
  outstandingTabs,
  previewAuditMetadata,
  reviewComplete,
  scrollSatisfied,
  withBridgeTimeout,
  withContext,
  withScrollSample,
  withScrollTrackingFailed,
  withTabViewed,
} from '../lib/previewReview'
import type { Currency } from '../lib/types'

// How long to wait for the customer page's context message before
// falling back to a scroll-only gate. Generous on purpose: the page
// posts context once its RPC returns, which on a slow connection can
// take a few seconds — and a late message still upgrades the gate to
// the full checklist.
const CONTEXT_TIMEOUT_MS = 6000
// Scroll measurements ride the iframe's scroll/resize events, with
// this poll as a backstop for what events miss: the page growing as
// images stream in, and a proof short enough to need no scrolling.
const SCROLL_POLL_MS = 500
// "The end" is within this many pixels of the true bottom, so the
// footer hairline never demands a pixel-perfect landing.
const BOTTOM_MARGIN_PX = 96

export interface VersionPreviewGateProps {
  proofId: string
  versionId: string
  versionNumber: number
  currency: Currency | null
  // Confirm advances to the next step in the parent flow. On both
  // NewVersionPage and EditVersionPage that's the MessageSendPanel.
  onConfirm: () => void
  // Edit returns the designer to the edit-version form for the
  // just-saved version so they can fix what they spotted.
  onEdit: () => void
  // Label for the confirm button once it unlocks — copy lives at the
  // call sites so the two flows can diverge again if they need to.
  confirmLabel: string
}

export default function VersionPreviewGate({
  proofId,
  versionId,
  versionNumber,
  currency,
  onConfirm,
  onEdit,
  confirmLabel,
}: VersionPreviewGateProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  // Wall-clock start for the audit entry's preview_seconds.
  const openedAtRef = useRef(Date.now())
  const [progress, setProgress] = useState(initialProgress)

  // Pre-send proof check (migration 000343) — the AI comparison of this
  // version's images against the customer's thread, offered right here in the
  // save flow so a designer can catch typos and missed change requests before
  // the customer sees the proof. Deliberately ADVISORY: it never gates the
  // confirm button, and it never runs by itself (each run costs real money —
  // the designer presses it when the revision history warrants it). The run
  // continues + persists server-side even if the designer confirms mid-run,
  // so the report is never lost — it shows on the project page afterwards.
  // Always force=true: on the edit flow a stored report predates the edit.
  const proofCheck = useProofCheck(versionId, null)
  const [reportOpen, setReportOpen] = useState(false)

  // Notes for the customer (migration 000347), offered HERE because this is
  // where the designer already is: the flow runs save -> review the preview ->
  // write the reply that sends the URL. Making them confirm, leave, find the
  // project page, add notes and come back would be a detour out of the one flow
  // that ends in sending. Post-save also means the image rows exist, so a note
  // can anchor to a real image rather than a not-yet-uploaded file.
  //
  // Deliberately not part of the checklist that gates the confirm button —
  // most versions want no notes at all.
  const calloutsEnabled = useCalloutsEnabled()
  const { session } = useAuth()
  const [notesOpen, setNotesOpen] = useState(false)
  const [noteCount, setNoteCount] = useState(0)

  // Build the iframe URL. ?preview=1 keeps the designer's hits out
  // of the customer-view audit ledger; ?v= pins to the specific
  // version the designer just saved.
  const previewSrc = `${customerProofPath(proofId)}?preview=1&v=${versionId}`

  // Bridge listener + context timeout. Messages are filtered to this
  // exact version — the designer can wander to older versions inside
  // the preview, and those pings must not tick anything off.
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return
      const msg = asPreviewPageMessage(ev.data)
      if (!msg || msg.versionId !== versionId) return
      if (msg.kind === 'context') {
        setProgress((p) => withContext(p, msg.tabs))
      } else {
        setProgress((p) => withTabViewed(p, msg.code))
      }
    }
    window.addEventListener('message', onMessage)
    const timeout = window.setTimeout(
      () => setProgress((p) => withBridgeTimeout(p)),
      CONTEXT_TIMEOUT_MS,
    )
    return () => {
      window.removeEventListener('message', onMessage)
      window.clearTimeout(timeout)
    }
  }, [versionId])

  // Scroll tracking against the same-origin iframe. Samples taken
  // before the bridge goes ready are discarded inside
  // withScrollSample — the pre-data page is a viewport-height spinner
  // that would otherwise count as "already at the end".
  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return
    let attachedWindow: Window | null = null

    const measure = () => {
      try {
        const win = iframe.contentWindow
        const doc = win?.document?.documentElement
        if (!win || !doc) return
        const scrollHeight = doc.scrollHeight
        const viewport = win.innerHeight
        if (scrollHeight <= 0 || viewport <= 0) return
        const shortPage = scrollHeight <= viewport + BOTTOM_MARGIN_PX
        const seen = win.scrollY + viewport
        const pct = shortPage ? 100 : (seen / scrollHeight) * 100
        const atEnd = shortPage || seen >= scrollHeight - BOTTOM_MARGIN_PX
        setProgress((p) => withScrollSample(p, pct, atEnd))
      } catch {
        // Same-origin access failed — the iframe navigated somewhere
        // unexpected. Waive the requirement rather than lock the
        // designer out; the audit entry records the degraded mode.
        setProgress((p) => withScrollTrackingFailed(p))
      }
    }

    const attach = () => {
      try {
        const win = iframe.contentWindow
        if (!win) return
        attachedWindow = win
        win.addEventListener('scroll', measure, { passive: true })
        win.addEventListener('resize', measure)
        measure()
      } catch {
        setProgress((p) => withScrollTrackingFailed(p))
      }
    }

    iframe.addEventListener('load', attach)
    const poll = window.setInterval(measure, SCROLL_POLL_MS)
    return () => {
      iframe.removeEventListener('load', attach)
      window.clearInterval(poll)
      try {
        attachedWindow?.removeEventListener('scroll', measure)
        attachedWindow?.removeEventListener('resize', measure)
      } catch {
        // The iframe window may already be gone — nothing to detach.
      }
    }
  }, [])

  const complete = reviewComplete(progress)
  const scrollDone = scrollSatisfied(progress)
  const pendingTabs = outstandingTabs(progress)

  // Both gate buttons carry the proof check's state as it stood on screen, so
  // "did a flag send them back to the form?" is a recorded fact rather than a
  // join between two timestamps — and survives the designer re-running the
  // check after fixing what it found.
  const auditMetadata = () => ({
    ...previewAuditMetadata(progress, openedAtRef.current, Date.now()),
    ...artworkCheckAuditFields(proofCheck.check.report),
  })

  const handleConfirm = () => {
    void logAudit({
      action: 'version.preview_confirmed',
      targetType: 'version',
      targetId: versionId,
      targetLabel: `v${versionNumber}`,
      metadata: auditMetadata(),
    })
    onConfirm()
  }

  const handleEdit = async () => {
    // Awaited, unlike the confirm path's fire-and-forget: onEdit may
    // reload the document (EditVersionPage does, to re-sync the form
    // with the just-saved DB state), which would cancel an in-flight
    // audit write. logAudit never rejects, so this costs at most one
    // quiet round-trip before the form re-appears.
    await logAudit({
      action: 'version.preview_edit_return',
      targetType: 'version',
      targetId: versionId,
      targetLabel: `v${versionNumber}`,
      metadata: auditMetadata(),
    })
    onEdit()
  }

  // Clicking a tab chip drives the preview: the customer page switches
  // to that tab and scrolls its plate grid into view.
  const jumpToTab = (code: string) => {
    postShowTab(iframeRef.current?.contentWindow, versionId, code)
  }

  // Two vocabularies, kept apart on purpose. Everything actionable gets a
  // visible outline; everything that only reports state gets none.
  //
  // The old markup gave both `ring-1 ring-ink` — an ink ring on an ink banner,
  // i.e. invisible — so the secondary buttons read as bare text while the
  // progress chips read as buttons that did nothing. The only thing that looked
  // pressable was the green fill.
  const chipBase = 'inline-flex items-center gap-1.5 text-xs font-medium'
  const actionBase =
    'inline-flex items-center gap-1.5 rounded-lg border border-line bg-canvas px-3 py-2 ' +
    'text-sm font-medium text-ink-soft transition-colors hover:border-ink-mute hover:text-ink ' +
    'focus-visible:outline-2 focus-visible:outline-offset-2 ' +
    'focus-visible:outline-[var(--c-brand)] disabled:cursor-not-allowed disabled:opacity-40'

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-canvas">
      {/* Banner — gray-900 so it's unambiguously app chrome, not part
          of the customer page rendered below. Row 1: label + actions;
          row 2: the review checklist. Collapses cleanly on narrow
          viewports. */}
      {/* Light, because this IS the app — the same chrome as every other
          designer surface. It used to be gray-900, which sat directly above the
          customer page's own black masthead with no boundary between them, so
          our controls and their design read as one undifferentiated mass. That
          blur was the real reason the banner felt unstructured; making the
          secondary buttons visible (PR #559) helped but could not fix it.

          A light banner also lets the buttons be ordinary buttons instead of
          hand-tuned outlines on a dark ground. */}
      <div
        data-testid="preview-gate-banner"
        className="border-b border-line bg-surface px-4 py-3 text-ink shadow-[0_1px_0_rgba(22,19,17,0.06)] sm:px-6"
      >
        <div className="mx-auto flex max-w-6xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <div className="flex items-center gap-2">
              <Eye size={16} className="text-ink-mute" aria-hidden="true" />
              <span className="text-sm font-semibold">Preview — what the customer will see</span>
            </div>
            <div className="flex items-center gap-3 text-xs text-ink-mute">
              <span>Version v{versionNumber}</span>
              {currency && (
                <>
                  <span aria-hidden="true" className="text-line">·</span>
                  <span>Currency {currency}</span>
                </>
              )}
            </div>
          </div>
          {/* The things you might DO before sending sit together: add a note,
              run the proof check, then send. "Go back and edit" is the escape
              hatch rather than a step, so it drops to the row below. */}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {calloutsEnabled && (
              <button type="button" onClick={() => setNotesOpen(true)} className={actionBase}>
                <MessageSquare size={15} aria-hidden="true" />
                {noteCount > 0 ? `Notes · ${noteCount}` : 'Add a note'}
              </button>
            )}
            {proofCheck.enabled && (proofCheck.check.status === 'running' ? (
              <span className={`${actionBase} pointer-events-none text-ink-mute`}>
                <InlineSpinner className="h-3 w-3" />
                Checking…
              </span>
            ) : proofCheck.check.report ? (
              (() => {
                const v = artworkVerdict(proofCheck.check.report, 'Proof check')
                const suffix = v.text.startsWith('Proof check — ')
                  ? v.text.slice('Proof check — '.length)
                  : 'couldn’t run'
                return (
                  <button
                    type="button"
                    onClick={() => setReportOpen(true)}
                    title={`${v.text} — open the report`}
                    className={actionBase}
                  >
                    <span aria-hidden="true">{v.icon}</span>
                    Proof check · {suffix}
                  </button>
                )
              })()
            ) : (
              <button
                type="button"
                onClick={() => void proofCheck.run(true)}
                title={proofCheck.runError ?? 'Optional: check this version against everything the customer sent — the thread, attachments and QR contents — before they see it. Takes about half a minute.'}
                className={actionBase}
              >
                <ScanSearch size={15} aria-hidden="true" />
                {proofCheck.runError ? 'Proof check — retry' : 'Run proof check'}
              </button>
            ))}
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!complete}
              title={
                complete
                  ? undefined
                  : progress.bridge === 'waiting'
                    ? 'Loading preview…'
                    : 'Finish the checks below first'
              }
              className="inline-flex items-center rounded-lg bg-in-stock px-4 py-2 text-sm font-semibold text-on-ink shadow-sm transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-brand)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:opacity-40"
            >
              {confirmLabel}
            </button>
          </div>
        </div>

        {/* Review checklist. The chips ARE the explanation for the
            disabled button, so they sit directly under it. aria-live
            lets screen readers hear items ticking off. */}
        <div
          aria-live="polite"
          className="mx-auto mt-2.5 flex max-w-6xl flex-wrap items-center gap-2"
        >
          {progress.bridge === 'waiting' ? (
            <span className="text-xs text-ink-dim">Loading preview…</span>
          ) : (
            <>
              {progress.scrollTracking === 'ok' && (
                <span
                  className={`${chipBase} ${scrollDone ? 'text-ink-dim' : 'text-on-ink'}`}
                >
                  {scrollDone ? (
                    <Check size={12} className="text-in-stock" aria-hidden="true" />
                  ) : (
                    <ArrowDown size={12} aria-hidden="true" />
                  )}
                  {scrollDone
                    ? 'Scrolled to the end'
                    : `Scroll to the end${progress.maxScrollPct > 0 ? ` · ${progress.maxScrollPct}%` : ''}`}
                </span>
              )}
              {progress.tabs.map((tab) => {
                // Stable order (chips never jump as they tick off);
                // viewed state changes the icon and dims the text.
                const viewed = progress.viewedTabCodes.includes(tab.code)
                return (
                  <button
                    key={tab.code}
                    type="button"
                    onClick={() => jumpToTab(tab.code)}
                    className={`${chipBase} ${viewed ? 'text-ink-dim hover:text-on-ink' : 'text-on-ink hover:bg-ink'}`}
                  >
                    {viewed ? (
                      <Check size={12} className="text-in-stock" aria-hidden="true" />
                    ) : (
                      <Eye size={12} aria-hidden="true" />
                    )}
                    {tab.label}
                  </button>
                )
              })}
              {pendingTabs.length > 0 && (
                <span className="text-xs text-ink-dim">Click an option to view it</span>
              )}
              {complete && <span className="text-xs text-ink-dim">All checked — over to you</span>}
            </>
          )}

          {/* Pre-send proof check chip — pushed right so it reads as the
              optional extra beside the required review checklist. Idle →
              run; running → spinner (the designer keeps reviewing, the run
              continues server-side regardless); done → the verdict, click
              for the full report. */}
          <button
            type="button"
            onClick={handleEdit}
            className={`${actionBase} ml-auto !py-1 !text-xs`}
          >
            Go back and edit
          </button>
        </div>
      </div>

      {/* The iframe carries the actual customer page. flex-1 makes
          it fill the remaining viewport height; the parent uses
          fixed-inset so the iframe always has a fixed sizing
          context regardless of how tall the underlying page is.
          title is required for a11y; no sandbox attribute is
          deliberate (same-origin needed for the customer page's
          Supabase calls, its lightbox/scroll behaviour, and the
          preview bridge + scroll tracking above). */}
      <iframe
        ref={iframeRef}
        src={previewSrc}
        title={`Preview of version v${versionNumber} as the customer will see it`}
        className="flex-1 w-full border-0 bg-canvas"
      />

      {/* The proof-check report — same capped, internally-scrolling panel as
          the Orders-page archive modal (pinned label + Close, long reports
          scroll between). Renders above the gate via the Modal portal. */}
      {reportOpen && proofCheck.check.report && (
        <Modal
          open
          onClose={() => setReportOpen(false)}
          ariaLabel="Proof check report"
          panelClassName="w-full max-w-xl rounded-2xl bg-white shadow-xl md:flex md:max-h-[85vh] md:flex-col"
        >
          <div className="shrink-0 px-5 pt-5 pb-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-ink-mute">
              Proof check · v{versionNumber}
            </p>
          </div>
          <div className="px-5 text-[13px] text-ink md:min-h-0 md:flex-1 md:overflow-y-auto">
            {proofCheck.check.status === 'running' && (
              <p className="mb-3 flex items-center gap-2 text-[13px] text-ink-mute">
                <InlineSpinner className="h-3 w-3" />
                Re-checking — the report below is the previous run…
              </p>
            )}
            <ArtworkCheckReportView
              report={proofCheck.check.report}
              heading="Proof check"
              action={
                <button
                  type="button"
                  onClick={() => void proofCheck.run(true)}
                  disabled={proofCheck.check.status === 'running'}
                  className="text-[13px] font-medium text-brand hover:underline disabled:opacity-50"
                >
                  Re-check
                </button>
              }
              notice={proofCheck.staleNotice}
              onInvestigate={(flag) => void proofCheck.investigate(flag)}
              investigatingKey={proofCheck.investigatingKey}
              investigationError={proofCheck.investigationError}
              onAcknowledge={(target, reason) => void proofCheck.acknowledge(target, reason)}
              onUnacknowledge={(target) => void proofCheck.unacknowledge(target)}
              acknowledgingKey={proofCheck.acknowledgingKey}
              acknowledgeError={proofCheck.acknowledgeError}
              history={{ versionId }}
            />
          </div>
          <div className="mt-1 flex shrink-0 justify-end border-t border-line-soft px-5 py-3">
            <button
              type="button"
              onClick={() => setReportOpen(false)}
              className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-ink-soft ring-1 ring-line hover:bg-canvas"
            >
              Close
            </button>
          </div>
        </Modal>
      )}

      {/* Notes editor (migration 000347). On close the preview iframe is
          reloaded, so the designer immediately sees the note exactly as the
          customer will — beside the card, in the collapsed strip — rather than
          having to take it on trust. */}
      {notesOpen && session?.user?.id && (
        <ProofAnnotationEditor
          open
          onClose={() => {
            setNotesOpen(false)
            const frame = iframeRef.current
            if (frame) frame.src = frame.src
          }}
          versionId={versionId}
          versionNumber={versionNumber}
          userId={session.user.id}
          onCountChange={setNoteCount}
        />
      )}
    </div>
  )
}
