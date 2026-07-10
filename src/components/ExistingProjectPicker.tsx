// Picker for "bring an existing project into this set" (bundle orders
// Slice 3). Lists the customer's other standalone projects — same contact,
// not already in a set, not abandoned — and lets the designer choose one to
// attach as another card. The host page wraps this in its own modal shell
// and performs the actual attach (ProofDetailPage may need to create the
// set first; the workspace attaches directly).

import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { listAttachableProofs, type AttachableProof } from '../lib/proofSets'
import { ButtonCoral, ButtonGhost, ProofStatusPill, type ProofStatus } from '../design'

function labelFor(p: AttachableProof): string {
  const names = p.names.filter((n) => n.trim().length > 0)
  if (names.length > 0) return names.join(' & ')
  return p.material_display?.trim() || 'Untitled project'
}

export default function ExistingProjectPicker({
  contactId,
  excludeProofId,
  attachBusy,
  onAttach,
  onBack,
  backLabel = 'Back',
}: {
  contactId: string
  // The project the designer is standing on (already in / becoming the set).
  excludeProofId?: string
  attachBusy: boolean
  onAttach: (proofId: string) => void
  onBack: () => void
  backLabel?: string
}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<AttachableProof[]>([])
  const [picked, setPicked] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const rows = await listAttachableProofs(contactId, excludeProofId)
        if (!cancelled) setCandidates(rows)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [contactId, excludeProofId])

  // The auth session is required by RLS for the reads above; surface a
  // friendly line if it lapsed rather than an opaque empty list.
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      if (!data.session) setError('Your session has expired — refresh and sign in again.')
    })
  }, [])

  if (loading) {
    return <p className="py-6 text-center text-sm text-ink-mute">Looking up this customer’s other projects…</p>
  }

  if (error) {
    return (
      <div>
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-200">{error}</p>
        <div className="mt-4 flex justify-end">
          <ButtonGhost onClick={onBack}>{backLabel}</ButtonGhost>
        </div>
      </div>
    )
  }

  if (candidates.length === 0) {
    return (
      <div>
        <p className="py-4 text-sm text-ink-soft">
          This customer has no other standalone projects to bring in — every other project is either
          already in a bundle or abandoned. Use “Start a new card” instead.
        </p>
        <div className="mt-2 flex justify-end">
          <ButtonGhost onClick={onBack}>{backLabel}</ButtonGhost>
        </div>
      </div>
    )
  }

  return (
    <div>
      <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
        {candidates.map((p) => (
          <li key={p.id}>
            <label
              className={[
                'flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2.5 transition-colors',
                picked === p.id ? 'border-ink bg-canvas' : 'border-line bg-surface hover:border-ink/40',
              ].join(' ')}
            >
              <span className="flex min-w-0 items-center gap-2">
                <input
                  type="radio"
                  name="attach-project"
                  checked={picked === p.id}
                  onChange={() => setPicked(p.id)}
                  className="accent-current"
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-ink">{labelFor(p)}</span>
                  <span className="block truncate text-xs text-ink-mute">
                    {[
                      p.material_display ?? 'No artwork yet',
                      p.version_number != null ? `v${p.version_number}` : null,
                      new Date(p.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </span>
              <ProofStatusPill status={p.status as ProofStatus} />
            </label>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex items-center justify-end gap-2">
        <ButtonGhost onClick={onBack} disabled={attachBusy}>
          {backLabel}
        </ButtonGhost>
        <ButtonCoral onClick={() => picked && onAttach(picked)} disabled={!picked} busy={attachBusy}>
          Add to the bundle
        </ButtonCoral>
      </div>
    </div>
  )
}
