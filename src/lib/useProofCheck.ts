// Shared state + calls for the pre-send proof check (migration 000343) — the
// designer-triggered run of the artwork check against a proof version's own
// images. One hook so every surface (the ProofDetailPage panel, the
// VersionPreviewGate chip, anything future) drives the same invoke shapes and
// response handling; a change to the function's contract lands in one file.
//
// The hook owns: the settings gate read (proof_check_enabled — off hides every
// surface), the run itself, and the per-flag history investigation. Callers
// pass the version to target plus (optionally) that version's stored report to
// seed from, so a past run shows instantly without a network call.

import { useEffect, useRef, useState } from 'react'
import { FunctionsHttpError } from '@supabase/supabase-js'
import { supabase } from './supabase'
import type { ArtworkCheckReport } from '../components/ArtworkCheckReportView'
import { ackKey, type AckReason, type AckTarget } from './artworkAcks'

// Invoke artwork-check and surface the REAL failure. supabase-js parks a
// non-2xx response behind `error.context` (data stays null), so a caller that
// reads only `data` reduces every failure — a genuine server error, or a
// transient gateway 502 that never reached the function at all — to one
// generic line. That's exactly what hid the cause of the first live
// investigation failure (2026-07-24): a platform blip looked identical to a
// broken feature. Now: an HTTP error yields the function's own message; a
// fetch/relay failure yields an honest "network blip, try again".
export async function invokeArtworkCheck<T>(
  body: Record<string, unknown>,
): Promise<{ data: T | null; errMsg: string | null; errBody: ArtworkCheckErrorBody | null }> {
  try {
    const { data, error } = await supabase.functions.invoke<T>('artwork-check', { body })
    if (!error) return { data, errMsg: null, errBody: null }
    if (error instanceof FunctionsHttpError) {
      try {
        const parsed = (await error.context.json()) as ArtworkCheckErrorBody
        if (typeof parsed?.error === 'string' && parsed.error) {
          return { data: null, errMsg: parsed.error, errBody: parsed }
        }
      } catch { /* non-JSON error body */ }
      return { data: null, errMsg: 'The check service returned an error — try again.', errBody: null }
    }
    return { data: null, errMsg: 'Couldn’t reach the check service — usually a momentary network blip. Try again.', errBody: null }
  } catch {
    return { data: null, errMsg: 'Couldn’t reach the check service — usually a momentary network blip. Try again.', errBody: null }
  }
}

interface ArtworkCheckErrorBody {
  error?: unknown
  // 'stale_report' — the flag was clicked on a report the database no longer
  // holds (the check was re-run underneath the page); `report` is the current
  // one, so the caller can refresh in place.
  code?: unknown
  report?: ArtworkCheckReport
}

type Investigation = NonNullable<ArtworkCheckReport['investigations']>[string]

// One interpretation of an investigate response for every surface that offers
// the button (the review page, the Orders archive modal, the proof-check
// panel). Three outcomes: the walk; a stale report to swap in; or a message.
export interface InvestigateOutcome {
  investigation?: Investigation
  // The key the server cached it under — the STORED card label, which can
  // differ from the label on screen after a re-run.
  key?: string
  staleReport?: ArtworkCheckReport
  message?: string
}

export async function requestInvestigation(
  target: Record<string, unknown>,
  flag: { card: string; field: string },
): Promise<InvestigateOutcome> {
  const { data, errMsg, errBody } = await invokeArtworkCheck<{
    ok: boolean
    investigation?: Investigation
    key?: string
    error?: string
  }>({ ...target, investigate: flag })
  if (data?.ok && data.investigation) {
    return { investigation: data.investigation, key: data.key }
  }
  if (errBody?.code === 'stale_report' && errBody.report) {
    return { staleReport: errBody.report, message: errMsg ?? undefined }
  }
  return { message: errMsg ?? data?.error ?? 'The investigation couldn’t run — try again.' }
}

// One interpretation of an acknowledge ("Mark as addressed") response for
// every surface that offers the tick. Three outcomes, mirroring investigate:
// the updated report; a stale report to swap in (the check was re-run under
// the page, or the stored report isn't the one on screen); or a message.
export interface AcknowledgeOutcome {
  report?: ArtworkCheckReport
  staleReport?: ArtworkCheckReport
  message?: string
}

export async function requestAcknowledge(
  target: Record<string, unknown>,
  args: { target: AckTarget; reason?: AckReason; undo?: boolean; checkedAt: string },
): Promise<AcknowledgeOutcome> {
  const { data, errMsg, errBody } = await invokeArtworkCheck<{
    ok: boolean
    acknowledged?: boolean
    report?: ArtworkCheckReport
    error?: string
  }>({
    ...target,
    acknowledge: {
      ...args.target,
      checked_at: args.checkedAt,
      ...(args.undo ? { undo: true } : { reason: args.reason }),
    },
  })
  if (data?.ok && data.acknowledged && data.report) return { report: data.report }
  if (errBody?.code === 'stale_report' && errBody.report) {
    return { staleReport: errBody.report, message: errMsg ?? undefined }
  }
  // ok:true without the `acknowledged` sentinel = a pre-ack deploy of the
  // function answered with its cached-report path. Say so rather than
  // pretending the tick stuck.
  if (data?.ok && !data.acknowledged) {
    return { message: 'That didn’t save — the check service needs its latest update first. Try again shortly.' }
  }
  return { message: errMsg ?? data?.error ?? 'Couldn’t save that — try again.' }
}

// Merge a returned walk into a report under both the server's key and the one
// the open page rendered from, so the timeline appears immediately AND is
// still found once the page reloads the stored report.
export function mergeInvestigation(
  report: ArtworkCheckReport,
  keys: (string | undefined)[],
  investigation: Investigation,
): ArtworkCheckReport {
  const investigations = { ...(report.investigations ?? {}) }
  for (const k of keys) if (k) investigations[k] = investigation
  return { ...report, investigations }
}

export interface ProofCheckState {
  status: 'idle' | 'running' | 'done'
  report: ArtworkCheckReport | null
}

export function useProofCheck(
  versionId: string | null,
  // The version's stored artwork_check, when the caller has the row (the
  // detail page). Surfaces that always want a fresh run (the preview gate)
  // pass null and call run(true).
  seedReport: ArtworkCheckReport | null = null,
) {
  const [enabled, setEnabled] = useState(false)
  const [check, setCheck] = useState<ProofCheckState>({ status: 'idle', report: null })
  const [runError, setRunError] = useState<string | null>(null)
  const [investigatingKey, setInvestigatingKey] = useState<string | null>(null)
  const [investigationError, setInvestigationError] = useState<{ key: string; message: string } | null>(null)
  const [acknowledgingKey, setAcknowledgingKey] = useState<string | null>(null)
  const [acknowledgeError, setAcknowledgeError] = useState<{ key: string; message: string } | null>(null)
  // Shown above the report when it had to be swapped for the stored one — a
  // per-flag error would vanish with the flag it was keyed to.
  const [staleNotice, setStaleNotice] = useState<string | null>(null)

  // Is the feature on? One cheap read; off (or a failed read, or a
  // pre-000343 DB) simply hides the surfaces.
  useEffect(() => {
    void supabase
      .from('settings')
      .select('proof_check_enabled')
      .eq('id', 1)
      .maybeSingle()
      .then(({ data }) => {
        if ((data as { proof_check_enabled?: boolean | null } | null)?.proof_check_enabled === true) {
          setEnabled(true)
        }
      })
  }, [])

  // Seed from the stored report so a past run shows instantly (and re-seed
  // when the caller reloads its rows). Never clobbers an in-flight run — the
  // run's own response wins.
  useEffect(() => {
    setCheck((prev) => (prev.status === 'running' ? prev : { status: seedReport ? 'done' : 'idle', report: seedReport }))
  }, [versionId, seedReport])

  // Run (or force re-run) the check. A failed invoke keeps any previous
  // report — never empties good state. The ref (not state, which is a stale
  // closure inside an async fn) stops a double-click firing two runs.
  const runningRef = useRef(false)
  async function run(force: boolean) {
    if (!versionId || runningRef.current) return
    runningRef.current = true
    setRunError(null)
    setCheck((prev) => ({ ...prev, status: 'running' }))
    try {
      const { data, errMsg } = await invokeArtworkCheck<{
        ok: boolean
        enabled?: boolean
        report?: ArtworkCheckReport
        error?: string
      }>({ proof_version_id: versionId, ...(force ? { force: true } : {}) })
      if (!data?.ok || data.enabled === false || !data.report) {
        if (data?.enabled === false) setEnabled(false)
        setCheck((prev) => ({ status: prev.report ? 'done' : 'idle', report: prev.report }))
        setRunError(errMsg ?? data?.error ?? (data?.enabled === false ? null : 'The proof check couldn’t run — try again.'))
        return
      }
      setCheck({ status: 'done', report: data.report })
    } finally {
      runningRef.current = false
    }
  }

  // Per-flag history walk — same designer-triggered escalation as the order
  // check's, cached server-side on the stored report.
  async function investigate(flag: { card: string; field: string }) {
    if (!versionId) return
    const key = `${flag.card}::${flag.field}`
    setInvestigatingKey(key)
    setInvestigationError(null)
    setStaleNotice(null)
    try {
      const out = await requestInvestigation({ proof_version_id: versionId }, flag)
      if (out.investigation) {
        const inv = out.investigation
        setCheck((prev) => prev.report ? { ...prev, report: mergeInvestigation(prev.report, [out.key, key], inv) } : prev)
      } else if (out.staleReport) {
        // The check was re-run underneath us — show what's actually stored
        // rather than leaving a dead button on a report that's gone.
        const fresh = out.staleReport
        setCheck({ status: 'done', report: fresh })
        setStaleNotice(out.message ?? 'This check has been re-run — the flags below are the current ones.')
      } else {
        setInvestigationError({ key, message: out.message ?? 'The investigation couldn’t run — try again.' })
      }
    } finally {
      setInvestigatingKey(null)
    }
  }

  // Tick an advisory off (or untick it) on the stored report. The server is
  // the writer — the returned report replaces the local one, so a colleague's
  // ticks arrive with it. Sends the report's checked_at as the token: a tick
  // must land on exactly the report the designer read, or come back as
  // stale_report with the one actually stored.
  async function setAcknowledged(target: AckTarget, reason: AckReason | null, undo: boolean) {
    const report = check.report
    if (!versionId || !report) return
    const key = ackKey(target)
    setAcknowledgingKey(key)
    setAcknowledgeError(null)
    try {
      const out = await requestAcknowledge(
        { proof_version_id: versionId },
        { target, ...(undo ? { undo: true } : { reason: reason ?? undefined }), checkedAt: report.checked_at },
      )
      if (out.report) {
        setCheck({ status: 'done', report: out.report })
      } else if (out.staleReport) {
        setCheck({ status: 'done', report: out.staleReport })
        setStaleNotice(out.message ?? 'This check has been re-run — the items below are the current ones.')
      } else {
        setAcknowledgeError({ key, message: out.message ?? 'Couldn’t save that — try again.' })
      }
    } finally {
      setAcknowledgingKey(null)
    }
  }
  const acknowledge = (target: AckTarget, reason: AckReason) => setAcknowledged(target, reason, false)
  const unacknowledge = (target: AckTarget) => setAcknowledged(target, null, true)

  return {
    enabled,
    check,
    run,
    investigate,
    runError,
    investigatingKey,
    investigationError,
    staleNotice,
    acknowledge,
    unacknowledge,
    acknowledgingKey,
    acknowledgeError,
  }
}
