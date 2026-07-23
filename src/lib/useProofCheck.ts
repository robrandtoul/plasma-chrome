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
import { supabase } from './supabase'
import type { ArtworkCheckReport } from '../components/ArtworkCheckReportView'

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
      const { data } = await supabase.functions.invoke<{
        ok: boolean
        enabled?: boolean
        report?: ArtworkCheckReport
        error?: string
      }>('artwork-check', { body: { proof_version_id: versionId, ...(force ? { force: true } : {}) } })
      if (!data?.ok || data.enabled === false || !data.report) {
        if (data?.enabled === false) setEnabled(false)
        setCheck((prev) => ({ status: prev.report ? 'done' : 'idle', report: prev.report }))
        setRunError(data?.error ?? (data?.enabled === false ? null : 'The proof check couldn’t run — try again.'))
        return
      }
      setCheck({ status: 'done', report: data.report })
    } catch {
      setCheck((prev) => ({ status: prev.report ? 'done' : 'idle', report: prev.report }))
      setRunError('The proof check couldn’t run — try again.')
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
    try {
      const { data } = await supabase.functions.invoke<{
        ok: boolean
        investigation?: NonNullable<ArtworkCheckReport['investigations']>[string]
        error?: string
      }>('artwork-check', { body: { proof_version_id: versionId, investigate: flag } })
      if (data?.ok && data.investigation) {
        const inv = data.investigation
        setCheck((prev) => prev.report
          ? { ...prev, report: { ...prev.report, investigations: { ...(prev.report.investigations ?? {}), [key]: inv } } }
          : prev)
      } else {
        setInvestigationError({ key, message: data?.error ?? 'The investigation couldn’t run — try again.' })
      }
    } catch {
      setInvestigationError({ key, message: 'The investigation couldn’t run — try again.' })
    } finally {
      setInvestigatingKey(null)
    }
  }

  return { enabled, check, run, investigate, runError, investigatingKey, investigationError }
}
